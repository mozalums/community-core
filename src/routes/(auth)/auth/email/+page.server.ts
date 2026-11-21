import { fail, redirect } from '@sveltejs/kit';
import { peekMagicToken, mintEmailSession } from '$lib/server/magic-link';
import { confirmEmailChange, revertEmailChange } from '$lib/server/email-change';
import {
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS,
	SESSION_TTL
} from '$lib/server/session-store';
import type { Actions, PageServerLoad } from './$types';

// Both links from an address change land here. As on /auth/magic, the GET
// only peeks and a button spends the token, so a mail scanner's prefetch
// cannot confirm a change or undo one.
export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	const change = await peekMagicToken(token, 'email-change');
	if (change && token) return { kind: 'change' as const, token, email: change.email };
	const revert = await peekMagicToken(token, 'email-revert');
	if (revert && token) return { kind: 'revert' as const, token, email: revert.email };
	return { kind: 'dead' as const };
};

const REFUSED = {
	token: 'This link has expired or was already used.',
	gone: 'The account this link was for no longer has that address.',
	taken: 'That address now belongs to another account. Contact the site admins.'
} as const;

export const actions: Actions = {
	confirm: async ({ request, cookies, url }) => {
		const token = String((await request.formData()).get('token') ?? '');
		const outcome = await confirmEmailChange(token, url.origin);
		if (!outcome.ok) return fail(400, { error: REFUSED[outcome.reason] });

		// The old subject's sessions, this browser's included, are gone; this
		// browser proved the new address, so it signs in as it.
		const sessionId = await mintEmailSession(outcome.email, 'email-change');
		const expires = new Date(Date.now() + SESSION_TTL * 1000);
		cookies.set(SESSION_COOKIE_NAME, sessionId, { ...SESSION_COOKIE_OPTIONS, expires });
		throw redirect(303, outcome.callbackUrl);
	},

	revert: async ({ request, cookies }) => {
		const token = String((await request.formData()).get('token') ?? '');
		const outcome = await revertEmailChange(token);
		if (!outcome.ok) return fail(400, { error: REFUSED[outcome.reason] });
		cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
		return { reverted: true };
	}
};
