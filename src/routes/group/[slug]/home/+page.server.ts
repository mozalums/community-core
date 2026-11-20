import { error, redirect } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { listPublicMembers } from '$lib/server/members';
import { renderMarkdown } from '$lib/server/markdown';
import { skinCopy } from '$lib/server/skin-copy';
import { groupBase } from '$lib/group-nav';
import type { PageServerLoad } from './$types';

// The anon/home page, but reachable by signed-in users (the sidebar "Home" link,
// and the admin "View public page" preview). Guests are 302'd to the real public
// landing at "/" — they already see it there.
export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.user) throw redirect(302, groupBase(url.pathname, params.slug) || '/');
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	return {
		landingHtml: renderMarkdown(group.landingMd, { headingOffset: 1 }),
		heroHtml: skinCopy('landing-hero'),
		bandHtml: skinCopy('landing-band'),
		publicMembers: await listPublicMembers(group.id)
	};
};
