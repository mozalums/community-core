import { getGroupBySlug } from '$lib/server/groups';
import {
	listMembers,
	searchMembers,
	searchTokens,
	type Member,
	type SearchMatch
} from '$lib/server/members';
import { avatarIdsByEmailMd5, emailMd5 } from '$lib/server/avatars';
import { getStarredIds } from '$lib/server/stars';
import { filterFields } from '$lib/server/field-schema';
import { error } from '@sveltejs/kit';
import { memberRef } from '$lib/group-nav';
import type { PageServerLoad } from './$types';

// Search state lives in the URL (?q=) so results are bookmarkable and
// server-rendered. One free-form query searches everything; no query → full list.
// ?starred=1 narrows to the signed-in user's starred people.
//
// A field the skin marks `filter: exact` is also a parameter of its own
// (?country=Canada), matched on the whole stored value and AND'd with q. Only
// such fields are read; any other parameter is ignored and never sent back.
//
// A client may ask for this leaf's data alone (x-sveltekit-invalidated), which
// skips the members-gate layout unless this load awaits parent(); awaiting it
// runs the gate and propagates its redirect before anything is read.
export const load: PageServerLoad = async ({ params, url, locals, parent }) => {
	await parent();
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');

	const q = url.searchParams.get('q')?.trim() ?? '';
	// A query of nothing but emoji or punctuation has no words to search, so
	// the page lists everyone and says why rather than showing nobody.
	const words = searchTokens(q).length > 0;
	const unsearchable = !!q && !words;
	const starredView = url.searchParams.get('starred') === '1';
	const filters = filterFields()
		.map((f) => ({ key: f.key, label: f.label, value: url.searchParams.get(f.key)?.trim() ?? '' }))
		.filter((f) => f.value);
	const filtered = words || filters.length > 0;

	// The directory URL with q, the given filters and the starred view, so a
	// chip can drop its own filter and keep the rest.
	const hrefWith = (kept: typeof filters) => {
		const pairs: [string, string][] = [
			...(q ? [['q', q] as [string, string]] : []),
			...kept.map((f): [string, string] => [f.key, f.value]),
			...(starredView ? [['starred', '1'] as [string, string]] : [])
		];
		return pairs.length
			? `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`
			: '';
	};

	// `relaxed` means no member matched every word, so the search fell back to
	// matching any of them; `fuzzy` means nothing matched as typed and these are
	// close spellings. The page says so rather than letting the looser answer
	// pass for the one that was asked.
	const search = filtered
		? await searchMembers(group.id, {
				q,
				filters: filters.map(({ key, value }) => ({ key, value }))
			})
		: null;
	let members: (Member & { matched?: SearchMatch[] })[] = search
		? search.members
		: await listMembers(group.id);
	// The current user's starred member ids (drives the star state + the filter).
	const starredIds = await getStarredIds(group.id, locals.user?.subject).catch(
		() => new Set<string>()
	);
	if (starredView) members = members.filter((m) => starredIds.has(m.id));
	// Photo URL ids, keyed by the avatar table's md5 storage key. A member with no
	// entry gets null and the card skips straight to Gravatar.
	const avatarIds = await avatarIdsByEmailMd5().catch(() => new Map<string, string>());

	return {
		// The card shows a name, a city, a photo and, for a search, up to two
		// visible fields the query matched. The address is hashed here for
		// the Gravatar fallback and not sent: this page is members-only, but a
		// payload field is published to whoever loads the page, and nothing here
		// renders one.
		members: members.map((m) => ({
			id: m.id,
			ref: memberRef(m),
			name: m.name,
			city: m.city,
			avatarId: (m.email && avatarIds.get(emailMd5(m.email))) || null,
			starred: starredIds.has(m.id),
			matched: (m.matched ?? []).slice(0, 2)
		})),
		count: members.length,
		filtered,
		relaxed: search?.relaxed ?? false,
		fuzzy: search?.fuzzy ?? false,
		unsearchable,
		starredView,
		filters: filters.map((f) => ({
			label: f.label,
			value: f.value,
			without: hrefWith(filters.filter((x) => x !== f))
		})),
		query: { q }
	};
};
