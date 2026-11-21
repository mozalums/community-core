import { redirect, fail } from '@sveltejs/kit';
import { clientAddress } from '$lib/server/client-address';
import { sendMagicLink } from '$lib/server/magic-link';
import { groupBase } from '$lib/group-nav';
import type { PageServerLoad, Actions } from './$types';

// A stranger's way in. Same magic link as /login, but the link lands on the
// request form rather than the directory, and the page explains the steps
// before it asks for an address. Anyone already signed in skips ahead to
// whichever step they are on.
export const load: PageServerLoad = async ({ parent, params, url }) => {
	const { member, isGroupAdmin, user } = await parent();
	const base = groupBase(url.pathname, params.slug);
	if (member || isGroupAdmin) throw redirect(303, `${base}/members`);
	if (user) throw redirect(303, `${base}/request`);
	return {};
};

export const actions: Actions = {
	send: async (event) => {
		const { request, url, params } = event;
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();

		const result = await sendMagicLink({
			email,
			callbackUrl: `${groupBase(url.pathname, params.slug)}/request`,
			origin: url.origin,
			ip: clientAddress(event)
		});

		if (!result.ok && result.reason === 'invalid') {
			return fail(400, { sent: false, error: 'Please enter a valid email address.', email });
		}
		// Generic success, rate-limited included, as on /login: the answer never
		// says whether the address is already a member.
		return { sent: true, error: null, email };
	}
};
