import { requireGroupAdmin } from '$lib/server/route-guards';
import { query } from '$lib/server/postgres';
import type { PageServerLoad } from './$types';

// Read-only admin snapshot. Membership requests are reviewed at
// /admin/requests.
export const load: PageServerLoad = async ({ params, locals }) => {
	const group = await requireGroupAdmin(params, locals);

	const { rows } = await query<{ n: string }>(
		`SELECT count(*)::text AS n FROM member WHERE group_id = $1 AND status = 'active'`,
		[group.id]
	);
	return { memberCount: Number(rows[0]?.n ?? 0) };
};
