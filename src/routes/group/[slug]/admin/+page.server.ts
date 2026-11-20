import { getGroupBySlug } from '$lib/server/groups';
import { query } from '$lib/server/postgres';
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Read-only admin snapshot. Membership requests are reviewed at
// /admin/requests.
export const load: PageServerLoad = async ({ params }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');

	const { rows } = await query<{ n: string }>(
		`SELECT count(*)::text AS n FROM member WHERE group_id = $1 AND status = 'active'`,
		[group.id]
	);
	return { memberCount: Number(rows[0]?.n ?? 0) };
};
