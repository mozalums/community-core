import { redirect } from '@sveltejs/kit';
import {
	deleteSession,
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS
} from '$lib/server/session-store';
import { safeLocalPath } from '$lib/callback-path';
import { log } from '$lib/server/log';
import type { RequestHandler } from './$types';

// POST only. A GET sign-out is reachable from any origin that can put a URL in
// front of the browser — an <img> cannot (the session cookie is SameSite=Lax,
// so it is withheld from a cross-site subresource), but a top-level navigation
// can, and so can any link a member is persuaded to follow. Every sign-out
// control in the tree submits a form; SvelteKit's origin check on
// form-content-type POSTs is what a third-party page cannot satisfy.
export const POST: RequestHandler = async ({ cookies, url }) => {
	const sessionId = cookies.get(SESSION_COOKIE_NAME);
	if (sessionId) {
		try {
			await deleteSession(sessionId);
		} catch (e) {
			log.error('logout.delete-session-failed', { sessionId, error: e as Error });
		}
	}

	cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);

	// Optional post-logout destination (e.g. the homepage with the login modal).
	throw redirect(303, safeLocalPath(url.searchParams.get('redirectTo'), '/'));
};
