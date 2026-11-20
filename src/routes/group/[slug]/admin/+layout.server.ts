import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

// Group-admin gate. Hooks already require a signed-in user on /group/*/admin; the
// parent group layout resolved isGroupAdmin (group_admin row OR global superadmin).
//
// A refusal costs the refused nothing. An admin link pasted into a group thread
// reaches mostly non-admins, and with email-only auth anyone signed out here pays
// an inbox round trip to get back in — so the session is left alone, the way
// hooks.server.ts already leaves a guest's alone. The 403 renders through
// group/[slug]/+error.svelte, which names the signed-in identity and offers
// sign-out as a choice for the person who really is in the wrong account.
export const load: LayoutServerLoad = async ({ parent }) => {
	const { isGroupAdmin } = await parent();
	if (!isGroupAdmin) throw error(403, 'Group admins only');
	return {};
};
