import { redirect } from '@sveltejs/kit';
import { groupBase } from '$lib/group-nav';
import { getGroupBySlug } from '$lib/server/groups';
import { pendingRemovalFor } from '$lib/server/member-removal';
import type { LayoutServerLoad } from './$types';

// Members-only gate. The hooks layer already guarantees a signed-in user on
// the members route (401 → /login). Here we add the access check: a signed-in
// visitor gets in if they're a synced member or a group admin; otherwise they're
// sent to the access-request form. The parent group layout has already resolved
// both. The redirect tracks the clean vs prefixed URL the visitor is on (default
// group serves clean root URLs).
//
// One exception: a member who just deleted their own profile is no longer a
// member, and a plain form POST whose cleanup failed renders this layout next.
// Sending them to the request form would hide that failure, so a removal still
// pending for this id sends its subject to the page that finishes it.
export const load: LayoutServerLoad = async ({ parent, params, url, locals }) => {
	const { member, isGroupAdmin } = await parent();
	if (member || isGroupAdmin) return {};
	const base = groupBase(url.pathname, params.slug);
	const group = 'id' in params && params.id ? await getGroupBySlug(params.slug) : null;
	if (group && (await pendingRemovalFor(group, params.id as string, locals.user ?? null))) {
		throw redirect(303, `${base}/removal/${params.id}`);
	}
	throw redirect(303, `${base}/request`);
};
