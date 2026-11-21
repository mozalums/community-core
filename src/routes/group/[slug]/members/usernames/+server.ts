import { json } from '@sveltejs/kit';
import { requireDirectoryAccess } from '$lib/server/route-guards';
import { hashId, rateLimitKey, rateLimited } from '$lib/server/rate-limit';
import { usernameStatus } from '$lib/server/usernames';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

// Per session: the edit page asks at most once per pause in typing, so this
// ceiling is far above what a person produces and well below a script walking
// a word list.
const RL_MAX = 60;
const RL_WINDOW_S = 60;

// The edit page's availability check: GET ?name=<typed> answers available,
// taken, invalid (with the rule it failed), reserved, or yours, for the caller's
// own profile. Behind the directory gate, which a +server.ts does not inherit
// from the members layout. A limiter Redis cannot reach lets the check through:
// what it answers, a member can already learn by opening /members/<name>, and
// the save action decides again under the unique index.
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { group, member } = await requireDirectoryAccess(params, locals);
	const session = hashId(locals.sessionId ?? locals.user?.subject ?? '');
	const over = await rateLimited(
		rateLimitKey('username-check:session', session),
		RL_MAX,
		RL_WINDOW_S
	).catch((e) => {
		log.warn('username-check.ratelimit-unavailable', { error: String(e) });
		return false;
	});
	if (over) {
		return json(
			{ status: 'limited', message: 'too many checks; wait a minute and try again' },
			{ status: 429, headers: { 'retry-after': String(RL_WINDOW_S) } }
		);
	}
	const name = url.searchParams.get('name') ?? '';
	return json(await usernameStatus(group.id, member?.id ?? null, name), {
		headers: { 'cache-control': 'private, no-store' }
	});
};
