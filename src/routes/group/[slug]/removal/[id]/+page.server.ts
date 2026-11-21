import { error, fail, redirect } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { pendingRemovalFor, removeMember } from '$lib/server/member-removal';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from '$lib/server/session-store';
import { groupBase } from '$lib/group-nav';
import type { Group } from '$lib/server/groups';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sits outside members/ because the member whose row is gone is no longer a
// member, and that layout would send them to the request form. The page exists
// only for a deletion whose purge committed and whose cleanup has not finished,
// and only for its subject or an admin; anyone else, and anyone once it has
// finished, gets the same 404 as an id that never existed.
// A visitor with no session is sent to sign in and back here, whatever the id:
// the last cleanup step revokes the requester's own sessions, so a removal that
// failed after it has a subject who can only return by signing in again, and
// redirecting every signed-out visitor alike tells nobody which ids are pending.
async function resolvePurged(
	params: { slug: string; id: string },
	locals: App.Locals,
	url: URL
): Promise<Group> {
	const group = await getGroupBySlug(params.slug);
	if (!group || !UUID.test(params.id)) throw error(404, 'No such member');
	if (!locals.user) {
		throw redirect(303, `/login?callbackUrl=${encodeURIComponent(url.pathname)}`);
	}
	if (!(await pendingRemovalFor(group, params.id, locals.user ?? null))) {
		throw error(404, 'No such member');
	}
	return group;
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	await resolvePurged(params, locals, url);
	return {};
};

export const actions: Actions = {
	default: async ({ params, locals, cookies, url }) => {
		const group = await resolvePurged(params, locals, url);
		const outcome = await removeMember(
			group,
			params.id,
			locals.user ?? null,
			cookies.get(SESSION_COOKIE_NAME)
		);
		if (!outcome.ok) return fail(500, { error: outcome.message });
		const base = groupBase(url.pathname, params.slug);
		if (outcome.self) {
			cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
			throw redirect(303, base || '/');
		}
		throw redirect(303, `${base}/members`);
	}
};
