import { redirect, fail } from '@sveltejs/kit';
import { clientAddress } from '$lib/server/client-address';
import { sendMagicLink } from '$lib/server/magic-link';
import { PASSKEYS_ENABLED } from '$lib/server/passkeys';
import { DEFAULT_DEST, safeLocalPath } from '$lib/callback-path';
import { baseOfPath } from '$lib/group-nav';
import type { PageServerLoad, Actions } from './$types';

// The canonical sign-in page + no-JS fallback for the modal. Enter an email, get
// a magic link. Signed-in visitors skip straight to their destination.
export const load: PageServerLoad = async ({ url, locals }) => {
	const callbackUrl = safeLocalPath(url.searchParams.get('callbackUrl'), DEFAULT_DEST);
	if (locals.user) throw redirect(303, callbackUrl);
	const error = url.searchParams.get('error') || '';
	// /login sits outside the group tree, so its exits follow the group the
	// visitor was headed for.
	const base = baseOfPath(callbackUrl);
	return {
		callbackUrl,
		error,
		home: base || '/',
		joinHref: `${base}/join`,
		passkeys: PASSKEYS_ENABLED
	};
};

export const actions: Actions = {
	send: async (event) => {
		const { request, url } = event;
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const callbackUrl = safeLocalPath(String(form.get('callbackUrl') ?? ''), DEFAULT_DEST);

		const result = await sendMagicLink({
			email,
			callbackUrl,
			origin: url.origin,
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
