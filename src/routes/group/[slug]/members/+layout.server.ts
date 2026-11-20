import { redirect } from '@sveltejs/kit';
import { groupBase } from '$lib/group-nav';
import type { LayoutServerLoad } from './$types';

// Members-only gate. The hooks layer already guarantees a signed-in user on
// the members route (401 → /login). Here we add the access check: a signed-in
// visitor gets in if they're a synced member or a group admin; otherwise they're
// sent to the access-request form. The parent group layout has already resolved
// both. The redirect tracks the clean vs prefixed URL the visitor is on (default
// group serves clean root URLs).
export const load: LayoutServerLoad = async ({ parent, params, url }) => {
	const { member, isGroupAdmin } = await parent();
	// Members and admins get in; everyone else goes to the access-request form.
	if (!member && !isGroupAdmin)
		throw redirect(303, `${groupBase(url.pathname, params.slug)}/request`);
	return {};
};
