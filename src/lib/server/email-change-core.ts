// The sign-in address is the identity key: `member.email` and
// `member.ident_subject` per group, `group_admin` by subject, `member_star` by
// the starrer's subject, and the session index in Redis. Moving it means
// moving every one of those at once, so this is the one statement sequence
// that does, shared by the member's own change, its revert and the operator
// script. No SvelteKit or $env imports, for that script's sake.

import { auditIn, type Queryable } from './audit-core';
import { lockMembersIn, setAddressIn, type Client as MemberClient } from './member-write-core';

export type Client = {
	query<R = Record<string, unknown>>(
		text: string,
		values?: unknown[]
	): Promise<{ rows: R[]; rowCount: number | null }>;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
	return EMAIL_RE.test(email);
}

/** The session subject an address signs in as. */
export const subjectFor = (email: string) => `email:${normalizeEmail(email)}`;

/**
 * True when the address is already somebody's: a member of any group, or a
 * group admin with no member row. Rows in `except` are the mover's own.
 */
export async function addressTakenIn(
	client: Client,
	email: string,
	except: readonly string[] = []
): Promise<boolean> {
	const { rows } = await client.query(
		`SELECT 1 FROM member WHERE email = $1 AND NOT (id = ANY($2::uuid[]))
		 UNION ALL
		 SELECT 1 FROM group_admin WHERE ident_subject = $3
		 LIMIT 1`,
		[email, except, subjectFor(email)]
	);
	return rows.length > 0;
}

export type MoveInput = {
	memberIds: readonly string[];
	to: string;
	action: 'member.email-changed' | 'member.email-reverted';
	actor: { actorSubject: string | null; actorEmail: string | null };
	/** Revert and operator recovery: a passkey a hijacker enrolled signs in as whoever holds the row. */
	dropPasskeys?: boolean;
};

export type MoveOutcome =
	| { ok: true; from: string[]; memberIds: string[]; epoch: string }
	| { ok: false; reason: 'gone' | 'taken' };

/**
 * Point the given member rows, and everything keyed by their current address,
 * at `to`. Runs on the caller's transaction and throws on any failure, so the
 * caller's ROLLBACK leaves every table where it was. `from` is each address
 * the rows held before, whose sessions the caller then revokes. Every moved
 * row gets a new `epoch`, which ends any change link issued before.
 */
export async function moveIdentityIn(client: Client, m: MoveInput): Promise<MoveOutcome> {
	const to = normalizeEmail(m.to);
	const rows = await lockMembersIn(client as unknown as MemberClient, m.memberIds);
	if (!rows.length) return { ok: false, reason: 'gone' };
	const ids = rows.map((r) => r.id);
	// lockMembersIn holds the identity lock, so this sees every committed claim
	// on `to` and no other can start before this transaction ends.
	if (await addressTakenIn(client, to, ids)) return { ok: false, reason: 'taken' };

	const from = [...new Set(rows.map((r) => r.email.toLowerCase()))].filter((e) => e !== to);
	const newSubject = subjectFor(to);
	const epoch = await setAddressIn(client as unknown as MemberClient, ids, to, newSubject);
	// No member or admin holds `to` (checked above), so a photo row there
	// belongs to nobody: a Gravatar cache or a departed holder's upload. The
	// mover's own photo replaces it and keeps its public id, so links to it
	// keep working.
	if (from.length) {
		await client.query(`DELETE FROM member_avatar WHERE email_md5 = md5($1)`, [to]);
	}
	for (const old of from) {
		const oldSubject = subjectFor(old);
		await client.query(
			`UPDATE group_admin SET ident_subject = $2, email = $3 WHERE ident_subject = $1`,
			[oldSubject, newSubject, to]
		);
		// A star the new subject already holds would collide on the primary key;
		// it says the same thing, so the old one goes.
		await client.query(
			`DELETE FROM member_star o WHERE o.starrer = $1 AND EXISTS (
			   SELECT 1 FROM member_star n
			    WHERE n.starrer = $2 AND n.group_id = o.group_id AND n.member_id = o.member_id)`,
			[oldSubject, newSubject]
		);
		await client.query(`UPDATE member_star SET starrer = $2 WHERE starrer = $1`, [
			oldSubject,
			newSubject
		]);
		await client.query(
			`UPDATE member_avatar SET email_md5 = md5($2), email = $2
			  WHERE email_md5 = md5($1)
			    AND NOT EXISTS (SELECT 1 FROM member_avatar WHERE email_md5 = md5($2))`,
			[old, to]
		);
	}
	if (m.dropPasskeys) {
		await client.query(`DELETE FROM passkey_credential WHERE member_id = ANY($1::uuid[])`, [ids]);
	}
	// One row per group, so each group's audit view shows its member's change.
	// The addresses sit in the unscrubbed actor and target columns: the
	// before/after payload is keyed `email` and would be digested.
	for (const r of rows) {
		await auditIn(client as Queryable, {
			...m.actor,
			category: 'authz',
			action: m.action,
			groupId: r.group_id,
			targetEmail: to,
			targetSubject: newSubject,
			targetId: r.id,
			before: { email: r.email },
			after: { email: to },
			meta: { from: r.email, to, passkeysRemoved: Boolean(m.dropPasskeys) }
		});
	}
	return { ok: true, from, memberIds: ids, epoch };
}

/**
 * Thrown when the identity gained or lost a membership between reading it and
 * locking its groups. The group locks are taken in id order to stay
 * deadlock-free, so one cannot be added afterwards; the caller reruns its
 * transaction instead.
 */
export class IdentityShifted extends Error {
	constructor() {
		super('the account changed while its groups were being locked; retry');
	}
}

type IdentityRow = { id: string; group_id: string; email: string; epoch: string };

async function identityIdsIn(client: Client, anchorIds: readonly string[]): Promise<string[]> {
	const { rows } = await client.query<{ id: string }>(
		`SELECT id FROM member
		  WHERE email IN (SELECT email FROM member WHERE id = ANY($1::uuid[]))
		  ORDER BY id`,
		[anchorIds]
	);
	return rows.map((r) => r.id);
}

/**
 * Lock the whole account the anchor rows belong to: every member row, in any
 * group, holding an address one of them holds now. The anchors are member ids
 * a link was issued for, so the account is found through rows that were part
 * of it, never through an address somebody else may since have taken.
 */
export async function lockIdentityIn(
	client: Client,
	anchorIds: readonly string[]
): Promise<IdentityRow[]> {
	const seen = await identityIdsIn(client, anchorIds);
	if (!seen.length) return [];
	const locked = await lockMembersIn(client as unknown as MemberClient, seen);
	const now = await identityIdsIn(client, anchorIds);
	if (now.join() !== seen.join() || locked.length !== seen.length) throw new IdentityShifted();
	const { rows } = await client.query<{ id: string; epoch: string }>(
		`SELECT id, identity_epoch::text AS epoch FROM member WHERE id = ANY($1::uuid[])`,
		[seen]
	);
	const epochs = new Map(rows.map((r) => [r.id, r.epoch]));
	return locked.map((r) => ({ ...r, epoch: epochs.get(r.id) ?? '0' }));
}

/** The address and epoch a change request is bound to, and whether the account has a passkey. */
export async function readIdentityIn(
	client: Client,
	memberId: string
): Promise<{ email: string; epoch: string; ids: string[]; passkeys: number } | null> {
	const { rows } = await client.query<{ email: string; epoch: string }>(
		`SELECT email::text AS email, identity_epoch::text AS epoch FROM member WHERE id = $1`,
		[memberId]
	);
	if (!rows[0]) return null;
	const ids = await identityIdsIn(client, [memberId]);
	const keys = await client.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = ANY($1::uuid[])`,
		[ids]
	);
	return { ...rows[0], ids, passkeys: keys.rows[0]?.n ?? 0 };
}

export type ChangeOutcome =
	| { ok: true; from: string[]; memberIds: string[]; grant: string }
	| { ok: false; reason: 'gone' | 'taken' };

/**
 * Apply a confirmed change link. It moves the account only if the member it
 * was requested for still holds the address it was requested from, under the
 * same epoch: any move since (a competing change, an undo, an operator)
 * spends every link issued before it. Records the undo grant for the notice.
 */
export async function confirmChangeIn(
	client: Client,
	c: {
		memberId: string;
		epoch: string;
		from: string;
		to: string;
		revertTtlSeconds: number;
	}
): Promise<ChangeOutcome> {
	const from = normalizeEmail(c.from);
	const rows = await lockIdentityIn(client, [c.memberId]);
	const anchor = rows.find((r) => r.id === c.memberId);
	if (!anchor || normalizeEmail(anchor.email) !== from || anchor.epoch !== c.epoch) {
		return { ok: false, reason: 'gone' };
	}
	const moved = await moveIdentityIn(client, {
		memberIds: rows.map((r) => r.id),
		to: c.to,
		action: 'member.email-changed',
		actor: { actorSubject: subjectFor(from), actorEmail: from }
	});
	if (!moved.ok) return moved;
	await client.query(`DELETE FROM email_revert_grant WHERE expires_at < now()`);
	const { rows: grant } = await client.query<{ id: string }>(
		`INSERT INTO email_revert_grant (member_ids, restore_to, epoch, expires_at)
		 VALUES ($1::uuid[], $2, $3, now() + make_interval(secs => $4))
		 RETURNING id`,
		[moved.memberIds, from, moved.epoch, c.revertTtlSeconds]
	);
	return { ok: true, from: moved.from, memberIds: moved.memberIds, grant: grant[0].id };
}

export type RevertOutcome =
	| { ok: true; from: string[]; memberIds: string[] }
	| { ok: false; reason: 'token' | 'gone' | 'taken' };

/**
 * Spend an undo grant: the account goes back to the address the notice went
 * to, wherever it has moved since and whatever groups it has joined, with
 * every passkey removed. The grant, and every grant issued after the change it
 * undoes, stops working, so a hijacker's later change cannot leave them an
 * undo link of their own. Earlier grants survive: they restore addresses the
 * owner held before.
 */
export async function revertGrantIn(client: Client, grantId: string): Promise<RevertOutcome> {
	const read = () =>
		client.query<{ member_ids: string[]; restore_to: string; epoch: string }>(
			`SELECT member_ids, restore_to::text AS restore_to, epoch::text AS epoch
			   FROM email_revert_grant
			  WHERE id = $1 AND spent_at IS NULL AND expires_at > now()`,
			[grantId]
		);
	const first = (await read()).rows[0];
	if (!first) return { ok: false, reason: 'token' };
	const rows = await lockIdentityIn(client, first.member_ids);
	if (!rows.length) return { ok: false, reason: 'gone' };
	// Two undos of one account serialize on its group locks, so the second
	// reads the grant only after the first has spent or voided it.
	const g = (await read()).rows[0];
	if (!g) return { ok: false, reason: 'token' };
	// A membership created before the lock joined the grant (migration 21);
	// rerun so the account is read from the grant as it now stands.
	if (g.member_ids.join() !== first.member_ids.join()) throw new IdentityShifted();
	const to = normalizeEmail(g.restore_to);
	const moved = await moveIdentityIn(client, {
		memberIds: rows.map((r) => r.id),
		to,
		action: 'member.email-reverted',
		actor: { actorSubject: subjectFor(to), actorEmail: to },
		dropPasskeys: true
	});
	if (!moved.ok) return moved;
	await client.query(
		`UPDATE email_revert_grant SET spent_at = now()
		  WHERE spent_at IS NULL AND member_ids && $1::uuid[] AND (id = $2 OR epoch > $3)`,
		[[...new Set([...moved.memberIds, ...g.member_ids])], grantId, g.epoch]
	);
	return { ok: true, from: moved.from, memberIds: moved.memberIds };
}

/**
 * Operator recovery: move the account holding `from` to `to`, remove its
 * passkeys and void every undo grant it has, since whoever holds the lost
 * addresses may hold those too. The epoch bump ends every change link.
 */
export async function recoverIdentityIn(
	client: Client,
	from: string,
	to: string
): Promise<MoveOutcome> {
	const anchors = await memberIdsForIn(client, normalizeEmail(from));
	const rows = anchors.length ? await lockIdentityIn(client, anchors) : [];
	if (!rows.length) return { ok: false, reason: 'gone' };
	const moved = await moveIdentityIn(client, {
		memberIds: rows.map((r) => r.id),
		to,
		action: 'member.email-changed',
		actor: { actorSubject: 'operator:change-member-email', actorEmail: null },
		dropPasskeys: true
	});
	if (moved.ok) {
		await client.query(
			`UPDATE email_revert_grant SET spent_at = now()
			  WHERE spent_at IS NULL AND member_ids && $1::uuid[]`,
			[moved.memberIds]
		);
	}
	return moved;
}

/** Every member row holding this address, across groups. */
export async function memberIdsForIn(client: Client, email: string): Promise<string[]> {
	const { rows } = await client.query<{ id: string }>(
		`SELECT id FROM member WHERE email = $1 ORDER BY id`,
		[email]
	);
	return rows.map((r) => r.id);
}
