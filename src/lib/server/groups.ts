import type pg from 'pg';
import { query } from '$lib/server/postgres';
import { isAdmin } from '$lib/server/admin';
import { log } from '$lib/server/log';

export type Group = {
	id: string;
	slug: string;
	name: string;
	landingMd: string | null;
	status: string;
};

type GroupRow = {
	id: string;
	slug: string;
	name: string;
	landing_md: string | null;
	status: string;
};

function mapGroup(r: GroupRow): Group {
	return {
		id: r.id,
		slug: r.slug,
		name: r.name,
		landingMd: r.landing_md,
		status: r.status
	};
}

const GROUP_COLS = `id, slug, name, landing_md, status`;
const IDENTITY_COLS = `id, slug, name, status`;

export type GroupIdentity = Omit<Group, 'landingMd'>;

// `{ landing: false }` leaves landing_md out of the SELECT, for a caller that
// has to resolve the group before it knows whether the requester may read it.
export async function getGroupBySlug(slug: string): Promise<Group | null>;
export async function getGroupBySlug(
	slug: string,
	opts: { landing: false }
): Promise<GroupIdentity | null>;
export async function getGroupBySlug(
	slug: string,
	opts?: { landing: false }
): Promise<Group | GroupIdentity | null> {
	if (opts?.landing === false) {
		const { rows } = await query<Omit<GroupRow, 'landing_md'>>(
			`SELECT ${IDENTITY_COLS} FROM "group" WHERE slug = $1 AND status = 'active'`,
			[slug]
		);
		const r = rows[0];
		return r ? { id: r.id, slug: r.slug, name: r.name, status: r.status } : null;
	}
	const { rows } = await query<GroupRow>(
		`SELECT ${GROUP_COLS} FROM "group" WHERE slug = $1 AND status = 'active'`,
		[slug]
	);
	return rows[0] ? mapGroup(rows[0]) : null;
}

export async function getGroupById(id: string): Promise<Group | null> {
	const { rows } = await query<GroupRow>(`SELECT ${GROUP_COLS} FROM "group" WHERE id = $1`, [id]);
	return rows[0] ? mapGroup(rows[0]) : null;
}

// Returns the text it replaced. The row lock taken by the subquery means a
// concurrent save cannot slip between the read and the write, so the caller's
// audit row names the version this save actually overwrote.
export async function updateLandingMd(
	db: Pick<pg.PoolClient, 'query'>,
	groupId: string,
	md: string
): Promise<string | null> {
	const { rows } = await db.query<{ previous: string | null }>(
		`UPDATE "group" g SET landing_md = $2, updated_at = now()
		   FROM (SELECT landing_md FROM "group" WHERE id = $1 FOR UPDATE) old
		  WHERE g.id = $1
		RETURNING old.landing_md AS previous`,
		[groupId, md]
	);
	return rows[0]?.previous ?? null;
}

// A subject is a group admin if it is a global superadmin (ADMIN_SUBJECTS) or
// has a row in this group's group_admin table. The env check comes first and
// does no I/O, so the break-glass account still gets in with Postgres down.
// A failed lookup answers "not an admin": the group layout calls this on every
// signed-in page, and a throw there is a 500 for the whole site.
export async function isGroupAdmin(
	groupId: string,
	subject: string | null | undefined
): Promise<boolean> {
	if (!subject) return false;
	if (isAdmin(subject)) return true;
	try {
		const { rows } = await query<{ one: number }>(
			`SELECT 1 AS one FROM group_admin WHERE group_id = $1 AND ident_subject = $2`,
			[groupId, subject]
		);
		return rows.length > 0;
	} catch (e) {
		log.warn('group-admin.lookup-failed', { groupId, error: e as Error });
		return false;
	}
}

// The session-shaped form of isGroupAdmin, for a caller holding `locals.user`.
export async function resolveGroupAdmin(
	group: Pick<Group, 'id'>,
	user: { subject: string } | null | undefined
): Promise<boolean> {
	return isGroupAdmin(group.id, user?.subject);
}

export type GroupAdminGrant = { subject: string; email: string | null; createdAt: string };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The subject a magic-link session for this address carries (magic-link.ts
// lowercases before minting), so a grant matches the person once they sign
// in. Null when the input is not an address.
export function adminSubjectFor(email: string): string | null {
	const addr = email.trim().toLowerCase();
	return EMAIL_SHAPE.test(addr) ? `email:${addr}` : null;
}

export async function listGroupAdmins(groupId: string): Promise<GroupAdminGrant[]> {
	const { rows } = await query<{ ident_subject: string; email: string | null; created_at: Date }>(
		`SELECT ident_subject, email, created_at FROM group_admin
		  WHERE group_id = $1 ORDER BY created_at, ident_subject`,
		[groupId]
	);
	return rows.map((r) => ({
		subject: r.ident_subject,
		email: r.email,
		createdAt: new Date(r.created_at).toISOString()
	}));
}

// Call first inside any transaction that changes a group's admin list. The row
// lock queues concurrent changes to one group behind each other, and the actor
// is re-checked after it because the request's guard ran before the lock: two
// admins revoking each other would otherwise both pass it and leave neither.
// False when the group is gone or the actor no longer holds admin.
export async function lockAdminChange(
	db: Pick<pg.PoolClient, 'query'>,
	groupId: string,
	actorSubject: string
): Promise<boolean> {
	const group = await db.query(`SELECT 1 AS one FROM "group" WHERE id = $1 FOR NO KEY UPDATE`, [
		groupId
	]);
	if (group.rows.length === 0) return false;
	if (isAdmin(actorSubject)) return true;
	const held = await db.query(
		`SELECT 1 AS one FROM group_admin WHERE group_id = $1 AND ident_subject = $2`,
		[groupId, actorSubject]
	);
	return held.rows.length > 0;
}

// True when a row was added; false when the subject already held the grant.
export async function grantGroupAdmin(
	db: Pick<pg.PoolClient, 'query'>,
	groupId: string,
	subject: string,
	email: string
): Promise<boolean> {
	const { rowCount } = await db.query(
		`INSERT INTO group_admin (group_id, ident_subject, email) VALUES ($1, $2, $3)
		 ON CONFLICT (group_id, ident_subject) DO NOTHING`,
		[groupId, subject, email]
	);
	return (rowCount ?? 0) > 0;
}

// The removed row, or null when there was none to remove.
export async function revokeGroupAdmin(
	db: Pick<pg.PoolClient, 'query'>,
	groupId: string,
	subject: string
): Promise<{ subject: string; email: string | null } | null> {
	const { rows } = await db.query<{ ident_subject: string; email: string | null }>(
		`DELETE FROM group_admin WHERE group_id = $1 AND ident_subject = $2
		 RETURNING ident_subject, email`,
		[groupId, subject]
	);
	return rows[0] ? { subject: rows[0].ident_subject, email: rows[0].email } : null;
}
