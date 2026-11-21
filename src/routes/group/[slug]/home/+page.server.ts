import { error, redirect } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { countMembers, listPublicMembers } from '$lib/server/members';
import { usernamesFor } from '$lib/server/usernames';
import { renderMarkdown } from '$lib/server/markdown';
import { skinCopy, withMemberCount } from '$lib/server/skin-copy';
import { groupBase } from '$lib/group-nav';
import type { PageServerLoad } from './$types';

// The anon/home page, but reachable by signed-in users (the sidebar "Home" link,
// and the admin "View public page" preview). Guests are 302'd to the real public
// landing at "/" — they already see it there.
export const load: PageServerLoad = async ({ locals, params, url, parent }) => {
	if (!locals.user) throw redirect(302, groupBase(url.pathname, params.slug) || '/');
	const { member, isGroupAdmin } = await parent();
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	const publicMembers = await listPublicMembers(group.id);
	return {
		landingHtml: renderMarkdown(group.landingMd, { headingOffset: 1 }),
		heroHtml: skinCopy('landing-hero'),
		bandHtml: await withMemberCount(skinCopy('landing-band'), () => countMembers(group.id)),
		publicMembers,
		// Only a member or admin gets linked avatars, so only they get the
		// usernames those links use; anyone else's payload carries none.
		profileRefs:
			member || isGroupAdmin
				? await usernamesFor(
						group.id,
						publicMembers.map((m) => m.id)
					)
				: null
	};
};
