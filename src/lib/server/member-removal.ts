import { error } from '@sveltejs/kit';
import { resolveGroupAdmin } from '$lib/server/groups';
import { getMemberById, canEditMember } from '$lib/server/members';
import { hardPurgeMember } from '$lib/server/member-write';
import { query, withTransaction } from '$lib/server/postgres';
import { deleteAvatar } from '$lib/server/avatars';
import { deleteSession, deleteUserSessions } from '$lib/server/session-store';
import { actorOf, auditIn, type Queryable } from '$lib/server/audit-core';
import { log } from '$lib/server/log';
import type { Group } from '$lib/server/groups';

/** What a removal clears once the row is gone: the photo keyed by the address, and the sessions indexed under each subject. */
export type RemovalTarget = { email: string; identSubject: string | null };

type Requester = { subject: string; email: string } | null;

export type RemovalOutcome =
	| { ok: true; self: boolean }
	| { ok: false; stage: 'purge' | 'cleanup'; message: string };

export const CLEANUP_FAILED =
	'The profile was deleted, but removing the photo or ending signed-in sessions did not finish. Try again.';

export const REMOVAL_COMPLETED = 'member.removal-completed';

// The member row is gone once its purge commits, so a cleanup that failed after
// it has nothing left to resolve but the audit row the purge wrote in the same
// transaction. That row is kept for the audit retention window, which is how
// long a retry can find the address. Two things end that authority before
// then. A later member with the same address or subject in this group owns
// that photo and those sessions now. And a completion row means the cleanup
// already ran to the end: sessions belong to the account, not the membership,
// so a later sign-in by the same address is not this removal's to revoke. The
// completion row shares the deletion row's category, so pruning never drops it
// while the deletion row it closes is still kept, and it carries only the id,
// so it adds no second copy of the address to the trail.
export async function purgedTarget(groupId: string, memberId: string): Promise<RemovalTarget | null> {
	const { rows } = await query<{ email: string | null; subject: string | null }>(
		`SELECT a.target_email::text AS email, a.target_subject AS subject
		   FROM audit_event a
		  WHERE a.group_id = $1 AND a.target_id = $2 AND a.action = 'member.deleted'
		    AND NOT EXISTS (
		          SELECT 1 FROM member m
		           WHERE m.group_id = $1
		             AND (m.email = a.target_email OR m.ident_subject = a.target_subject))
		    AND NOT EXISTS (
		          SELECT 1 FROM audit_event c
		           WHERE c.group_id = $1 AND c.target_id = $2 AND c.action = '${REMOVAL_COMPLETED}')
		  ORDER BY a.at DESC
		  LIMIT 1`,
		[groupId, memberId]
	);
	const row = rows[0];
	return row?.email ? { email: row.email, identSubject: row.subject } : null;
}

// Whether this requester may finish the removal of this id: it is still pending,
// and they are its subject or a group admin. Anyone else is told nothing.
export async function pendingRemovalFor(
	group: Group,
	memberId: string,
	user: Requester
): Promise<boolean> {
	if (!user) return false;
	const target = await purgedTarget(group.id, memberId);
	if (!target) return false;
	return canEditMember(target, user, false) || (await resolveGroupAdmin(group, user));
}

// Every step is idempotent, so a retry repeats the whole list. The requester's
// own sessions go last: any earlier failure leaves them signed in, and so able
// to retry, rather than signed out of a half-finished removal. The photo is
// deleted on `db`, the cleanup transaction's own connection: borrowing another
// from the pool while holding one lets overlapping removals hold every
// connection while each waits for one more.
export async function finishRemoval(
	db: Queryable,
	target: RemovalTarget,
	requester: Requester,
	sid?: string
): Promise<void> {
	await deleteAvatar(target.email, db);
	const own = requester?.subject;
	const subjects = [
		...new Set([`email:${target.email.toLowerCase()}`, target.identSubject ?? ''])
	].filter((s) => s !== '');
	subjects.sort((a, b) => Number(a === own) - Number(b === own));
	for (const subject of subjects) await deleteUserSessions(subject);
	if (sid) await deleteSession(sid);
}

// One removal's cleanup at a time. Every attempt takes this lock, then asks
// again whether the removal is still pending, so an attempt admitted before
// another one finished finds the completion row and stops instead of acting on
// a photo or a session that appeared after it.
const REMOVAL_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('member-removal:' || $1::text || ':' || $2::text, 0))`;

// Whether this removal has ended since an attempt was admitted: another attempt
// wrote its completion row, or the address or subject joined the group again.
// Run under REMOVAL_LOCK_SQL, it is the only answer an attempt acts on; the
// address it acts on comes from the deletion row, which never changes.
async function removalEnded(
	client: Queryable,
	groupId: string,
	memberId: string,
	target: RemovalTarget
): Promise<boolean> {
	const { rowCount } = await client.query(
		`SELECT 1
		  WHERE EXISTS (
		          SELECT 1 FROM audit_event c
		           WHERE c.group_id = $1 AND c.target_id = $2 AND c.action = '${REMOVAL_COMPLETED}')
		     OR EXISTS (
		          SELECT 1 FROM member m
		           WHERE m.group_id = $1 AND (m.email = $3 OR m.ident_subject = $4))`,
		[groupId, memberId, target.email, target.identSubject]
	);
	return (rowCount ?? 0) > 0;
}

// The purge commits first and alone (with its audit row); the photo and the
// sessions follow in a second transaction, because neither the avatar store
// nor Redis can roll back with the purge. That second transaction holds the
// removal lock and writes the completion row before touching either store: a
// completion row that cannot be written fails the attempt while the requester
// is still signed in and able to retry, and a cleanup that fails rolls the row
// back with it. A commit that fails after the sessions are gone leaves a
// signed-out subject; the removal page sends them through sign-in and back.
export async function removeMember(
	group: Group,
	memberId: string,
	user: Requester,
	sid: string | undefined
): Promise<RemovalOutcome> {
	const member = await getMemberById(group.id, memberId);
	const target: RemovalTarget | null = member ?? (await purgedTarget(group.id, memberId));
	if (!target) throw error(404, 'No such member');
	const self = canEditMember(target, user, false);
	if (!self && !(await resolveGroupAdmin(group, user))) {
		if (!member) throw error(404, 'No such member');
		throw error(403, 'You can only edit your own profile');
	}

	if (member) {
		try {
			await hardPurgeMember(
				group,
				member.id,
				actorOf(user),
				`email:${member.email.toLowerCase()}`
			);
		} catch (e) {
			log.error('member-delete.db-failed', { groupId: group.id, error: e as Error });
			return {
				ok: false,
				stage: 'purge',
				message: 'Could not delete the profile. Nothing was removed; try again.'
			};
		}
	}

	try {
		const cleaned = await withTransaction(async (client) => {
			await client.query(REMOVAL_LOCK_SQL, [group.id, memberId]);
			if (await removalEnded(client, group.id, memberId, target)) return false;
			await auditIn(client, {
				...actorOf(user),
				category: 'membership',
				action: REMOVAL_COMPLETED,
				groupId: group.id,
				groupSlug: group.slug,
				targetId: memberId
			});
			await finishRemoval(client, target, self ? user : null, self ? sid : undefined);
			return true;
		});
		if (!cleaned) {
			log.info('member-delete.cleanup-ended', { groupId: group.id, memberId });
			return { ok: true, self };
		}
	} catch (e) {
		log.error('member-delete.cleanup-failed', { groupId: group.id, memberId, error: e as Error });
		return { ok: false, stage: 'cleanup', message: CLEANUP_FAILED };
	}
	log.info('member-delete.done', { groupId: group.id, memberId, self });
	return { ok: true, self };
}
