import { redirect, fail } from '@sveltejs/kit';
import { clientAddress } from '$lib/server/client-address';
import {
	consumeMagicToken,
	peekMagicToken,
	mintEmailSession,
	sendMagicLink
} from '$lib/server/magic-link';
import {
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS,
	SESSION_TTL
} from '$lib/server/session-store';
import { refreshOnSignIn } from '$lib/server/gravatar';
import { destForLog } from '$lib/callback-path';
import { log } from '$lib/server/log';
import type { PageServerLoad, Actions } from './$types';

// The emailed link lands here as a GET that only peeks: nothing is consumed
// until the `confirm` action below. Microsoft Defender Safe Links prefetches by
// default across Microsoft 365 tenants and a prefetch is a GET, so consuming
// here would burn the token before its owner ever saw the mail — and with no
// password fallback, every link that member ever requests burns the same way.
// Scanners do not submit forms, so the button is what separates them.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	const payload = await peekMagicToken(token);
	if (!payload || !token) return { valid: false as const };
	return { valid: true as const, token, email: payload.email };
};

export const actions: Actions = {
	// A form action, not a `fetch`: SvelteKit's origin check runs on
	// form-content-type POSTs, so confirming carries CSRF coverage without this
	// route minting a token of its own.
	confirm: async ({ request, cookies }) => {
		const form = await request.formData();
		const payload = await consumeMagicToken(String(form.get('token') ?? ''));
		// The re-run load peeks the same dead token and renders the recovery form,
		// so this carries no message of its own.
		if (!payload) return fail(400, { sent: false, error: null, email: '' });

		const sessionId = await mintEmailSession(payload.email);

		// Not awaited, and that is the point: signing in must not get slower because
		// Gravatar is slow. Someone who just changed their picture would otherwise
		// wait out the seven-day TTL, and signing in is the moment they are most
		// likely to be looking for it.
		refreshOnSignIn(payload.email);

		// Cookie and Redis session share one lifetime (SESSION_TTL = 24 hours).
		const expires = new Date(Date.now() + SESSION_TTL * 1000);
		cookies.set(SESSION_COOKIE_NAME, sessionId, { ...SESSION_COOKIE_OPTIONS, expires });

		log.info('auth.magic.verified', {
			email: payload.email,
			dest: destForLog(payload.callbackUrl)
		});
		throw redirect(303, payload.callbackUrl);
	},

	// The way out of every dead end: expired, already used, or prefetched by
	// something that does submit forms. The destination is lost with the token,
	// so the fresh link goes to the default landing spot.
	resend: async (event) => {
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '').trim();

		const result = await sendMagicLink({
			email,
			origin: event.url.origin,
			ip: clientAddress(event)
		});

		if (!result.ok && result.reason === 'invalid') {
			return fail(400, { sent: false, error: 'Please enter a valid email address.', email });
		}
		// Generic success — also for rate-limited — so we never reveal whether an
		// address exists.
		return { sent: true, error: null, email };
	}
};
