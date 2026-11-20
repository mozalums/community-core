// Per-user "starred people" (member_star table). The starrer is the session
// subject (email:<addr>); the starred is a member id.
import { query } from '$lib/server/postgres';

export async function getStarredIds(
	groupId: string,
	starrer: string | null | undefined
): Promise<Set<string>> {
	if (!starrer) return new Set();
	const { rows } = await query<{ member_id: string }>(
		'SELECT member_id FROM member_star WHERE group_id = $1 AND starrer = $2',
		[groupId, starrer]
	);
	return new Set(rows.map((r) => r.member_id));
}

export async function addStar(groupId: string, starrer: string, memberId: string): Promise<void> {
	await query(
		`INSERT INTO member_star (group_id, starrer, member_id) VALUES ($1, $2, $3)
		 ON CONFLICT (group_id, starrer, member_id) DO NOTHING`,
		[groupId, starrer, memberId]
	);
}

export async function removeStar(
	groupId: string,
	starrer: string,
	memberId: string
): Promise<void> {
	await query('DELETE FROM member_star WHERE group_id = $1 AND starrer = $2 AND member_id = $3', [
		groupId,
		starrer,
		memberId
	]);
}
