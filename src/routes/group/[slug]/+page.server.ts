import { error, redirect } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { listPublicMembers } from '$lib/server/members';
import { renderMarkdown } from '$lib/server/markdown';
import { skinCopy } from '$lib/server/skin-copy';
import { groupBase } from '$lib/group-nav';
import type { PageServerLoad } from './$types';

// Public landing. Anyone already in the community (member or admin)
// skips the marketing splash straight to the directory. For guests: if the group
// has admin-authored landing Markdown, render it to HTML server-side (only HTML
// ships, never raw Markdown / scripts); otherwise the default Landing shows.
export const load: PageServerLoad = async ({ parent, params, url }) => {
	const { member, isGroupAdmin } = await parent();
	if (member || isGroupAdmin) {
		throw redirect(303, `${groupBase(url.pathname, params.slug)}/members`);
	}
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	return {
		landingHtml: renderMarkdown(group.landingMd, { headingOffset: 1 }),
		heroHtml: skinCopy('landing-hero'),
		bandHtml: skinCopy('landing-band'),
		publicMembers: await listPublicMembers(group.id)
	};
};
