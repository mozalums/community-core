import { error } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { skinCopy } from '$lib/server/skin-copy';
import type { PageServerLoad } from './$types';

// The skin's copy/code-of-conduct.md. A skin without one has no such page, and the
// group layout links to it nowhere.
export const load: PageServerLoad = async ({ params }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	const html = skinCopy('code-of-conduct');
	if (!html) throw error(404, 'Not found');
	return { html };
};
