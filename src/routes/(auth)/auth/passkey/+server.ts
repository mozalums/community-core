import { error, json } from '@sveltejs/kit';
import { clientAddress } from '$lib/server/client-address';
import { mintEmailSession, normalizeEmail, signInRateLimited } from '$lib/server/magic-link';
import { PASSKEYS_ENABLED } from '$lib/server/passkeys';
import { authenticationOptions, verifyPasskeySignIn } from '$lib/server/passkey-store';
import { rateLimitKey, rateLimited } from '$lib/server/rate-limit';
import {
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS,
	SESSION_TTL
} from '$lib/server/session-store';
import { refreshOnSignIn } from '$lib/server/gravatar';
import { DEFAULT_DEST, destForLog, safeLocalPath } from '$lib/callback-path';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

// Every login page with a passkey-capable browser asks for options on load, so
// the cap is wide. It exists because each request leaves a key in Redis for
// five minutes, and nothing else bounds how many an unauthenticated caller
// can leave.
const OPTIONS_MAX = 60;
const OPTIONS_WINDOW = 15 * 60;

// JSON, not a form action: the browser API takes and returns objects, and
// SvelteKit's origin check does not cover JSON bodies. Nothing here needs it:
// an assertion is bound to this origin by the authenticator, so another site
// cannot produce one, and the options carry nothing about any member.
export const POST: RequestHandler = async (event) => {
	if (!PASSKEYS_ENABLED) throw error(404, 'Not found');
	let body: { step?: unknown; response?: unknown; callbackUrl?: unknown };
	try {
		body = await event.request.json();
	} catch {
		throw error(400, 'Expected a JSON body');
	}
	const ip = clientAddress(event);

	if (body.step === 'options') {
		if (await rateLimited(rateLimitKey('passkey-rl:opt', ip), OPTIONS_MAX, OPTIONS_WINDOW)) {
			return json({ error: 'rate_limited' }, { status: 429 });
		}
		return json(await authenticationOptions());
	}
	if (body.step !== 'verify' || typeof body.response !== 'object' || !body.response) {
		throw error(400, 'Unknown step');
	}

	if (await signInRateLimited(ip)) {
		log.warn('auth.passkey.rate-limited', {});
		return json({ error: 'rate_limited' }, { status: 429 });
	}
	const outcome = await verifyPasskeySignIn(
		body.response as Parameters<typeof verifyPasskeySignIn>[0]
	);
	if (!outcome.ok) {
		log.info('auth.passkey.refused', { reason: outcome.reason });
		return json({ error: outcome.reason }, { status: 401 });
	}

	const email = normalizeEmail(outcome.email);
	const sessionId = await mintEmailSession(email, 'passkey');
	refreshOnSignIn(email);
	const expires = new Date(Date.now() + SESSION_TTL * 1000);
	event.cookies.set(SESSION_COOKIE_NAME, sessionId, { ...SESSION_COOKIE_OPTIONS, expires });

	const dest = safeLocalPath(
		typeof body.callbackUrl === 'string' ? body.callbackUrl : null,
		DEFAULT_DEST
	);
	log.info('auth.passkey.verified', { email, memberId: outcome.memberId, dest: destForLog(dest) });
	return json({ redirect: dest });
};
