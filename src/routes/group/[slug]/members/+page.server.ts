import { getGroupBySlug } from '$lib/server/groups';
import { listMembers, searchMembers } from '$lib/server/members';
import { avatarIdsByEmailMd5, emailMd5 } from '$lib/server/avatars';
import { gravatarHash } from '$lib/server/gravatar';
import { getStarredIds } from '$lib/server/stars';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Search state lives in the URL (?q=) so results are bookmarkable and
// server-rendered. One free-form query searches everything; no query → full list.
// ?starred=1 narrows to the signed-in user's starred people.
export const load: PageServerLoad = async ({ params, url, locals }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');

	const q = url.searchParams.get('q')?.trim() ?? '';
	const filtered = !!q;
	const starredView = url.searchParams.get('starred') === '1';

	// `relaxed` means no member matched every word, so the search fell back to
	// matching any of them — the page says so rather than letting the looser
	// answer pass for the one that was asked.
	const search = filtered ? await searchMembers(group.id, { q }) : null;
	let members = search ? search.members : await listMembers(group.id);
	// The current user's starred member ids (drives the star state + the filter).
	const starredIds = await getStarredIds(group.id, locals.user?.subject).catch(
		() => new Set<string>()
	);
	if (starredView) members = members.filter((m) => starredIds.has(m.id));
	// Photo URL ids, keyed by the avatar table's md5 storage key. A member with no
	// entry gets null and the card skips straight to Gravatar.
	const avatarIds = await avatarIdsByEmailMd5().catch(() => new Map<string, string>());

	return {
		// The card shows a name, a city and a photo. The address is hashed here for
		// the Gravatar fallback and not sent: this page is members-only, but a
		// payload field is published to whoever loads the page, and nothing here
		// renders one.
		members: members.map((m) => ({
			id: m.id,
			name: m.name,
			city: m.city,
			gravatarHash: gravatarHash(m.email),
			avatarId: (m.email && avatarIds.get(emailMd5(m.email))) || null,
			starred: starredIds.has(m.id)
		})),
		count: members.length,
		filtered,
		relaxed: search?.relaxed ?? false,
		starredView,
		query: { q }
	};
};
