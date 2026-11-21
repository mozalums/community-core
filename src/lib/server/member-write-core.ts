// Every write to a member row: update, create, soft-remove, hard-purge, and
// the bulk import's insert, update and removal.
// Pure: no SvelteKit or $env imports, so a script or an import job can run it
// over its own client. member-write.ts binds it to the app's pool.
//
// Concurrency. A member is addressed by its immutable uuid, never by a position
// in some other store, so nothing between reading and writing can make the
// write land on a different person. Each mutation is one transaction that
// takes a transaction-scoped advisory lock keyed on the group (so it orders
// against a concurrent bulk import of the same group), then reads the row once
// under FOR UPDATE, computes the change in JS against that locked row, and
// writes it with one statement. The affiliation checkboxes are ordinary fields
// in the same patch and go out in that same UPDATE, so there is no second write
// path to skew against. The cross-member race the sheet integration had (a
// row number read, then a row inserted, then a write to the old number) cannot
// recur here because no row number exists to go stale. The audit row is
// written on the same client before COMMIT, so a mutation and its record
// commit together or neither does.

import type pg from 'pg';
import { auditIn, diffFields, type AuditEntry } from './audit-core';
import {
	DEFAULT_FIELD_SCHEMA,
	fieldsFor,
	isChecked,
	isFormWritable,
	ownValue,
	promotedKeys,
	splitData,
	type FieldDef
} from './field-schema';
import { checkProfileUrl } from './profile-url';

export type Client = Pick<pg.ClientBase, 'query'>;
export type Actor = Pick<AuditEntry, 'actorSubject' | 'actorEmail'>;
export type GroupRef = { id: string; slug: string };
export type Patch = Record<string, string | boolean>;

// Admin rights over the group, resolved by the caller from the session. The
// member's own authority is not taken from the caller: it is decided here,
// from the locked row.
export type Authority = { admin: boolean };

export class MemberWriteError extends Error {
	constructor(
		readonly status: 400 | 403 | 404 | 409,
		message: string,
		// The field the refusal is about, so a form can show it beside that control.
		readonly field?: string
	) {
		super(message);
		this.name = 'MemberWriteError';
	}
}

// hashtextextended folds the group id into the bigint pg_advisory_xact_lock
// takes. The prefix keeps this key apart from any other lock keyed on a group.
// An import of a group must take this same statement to order against saves.
export const GROUP_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('member-write:' || $1::text, 0))`;

export const SELECT_FOR_UPDATE_SQL = `SELECT email::text AS email, ident_subject, data, private_data, name, city, linkedin
	   FROM member
	  WHERE group_id = $1 AND id = $2 AND status = 'active'
	  FOR UPDATE`;

export const UPDATE_SQL = `UPDATE member
	    SET data = $3::jsonb, private_data = $4::jsonb, name = $5, city = $6, linkedin = $7
	  WHERE group_id = $1 AND id = $2`;

type LockedRow = {
	email: string;
	ident_subject: string | null;
	data: Record<string, unknown> | null;
	private_data: Record<string, unknown> | null;
	name: string | null;
	city: string | null;
	linkedin: string | null;
};

type Typed = 'name' | 'city' | 'linkedin';

const asText = (v: unknown) => (v == null ? '' : String(v));

// ---------------------------------------------------------------------------
// Pure steps
// ---------------------------------------------------------------------------

export type ValidateOptions = {
	// Which writer this is. 'form' refuses fields no profile form may write
	// (email, the photo URL, retired and x.* columns); 'system' does not, and
	// is what approval and the avatar route use.
	writer: 'form' | 'system';
	// Whether the caller may write private fields: a group admin, or the member.
	mayWritePrivate: boolean;
	// Fields a 'form' writer may still set although no form shows them.
	allow?: readonly string[];
	schema?: readonly FieldDef[];
};

// Every key is checked, never skipped. A key the schema does not know is an
// error rather than a silent drop, because a dropped key is how a renamed
// column used to make a field vanish with nobody told. Returns the patch to
// write, which differs from the input only where a URL was given its scheme.
export function validatePatch(patch: Patch, opts: ValidateOptions): Patch {
	const defs = fieldsFor(Object.keys(patch), opts.schema ?? DEFAULT_FIELD_SCHEMA);
	const byKey = new Map(defs.map((f) => [f.key, f]));
	const out: Patch = Object.assign(Object.create(null), patch);
	for (const [key, value] of Object.entries(patch)) {
		const f = byKey.get(key);
		if (!f) throw new MemberWriteError(400, `unknown field "${key}"`);
		if (opts.writer === 'form' && !isFormWritable(f) && !opts.allow?.includes(key)) {
			throw new MemberWriteError(400, `field "${key}" cannot be edited`);
		}
		if ((f.type === 'checkbox') !== (typeof value === 'boolean')) {
			throw new MemberWriteError(400, `field "${key}" has the wrong type`);
		}
		if (f.visibility === 'private' && !opts.mayWritePrivate) {
			throw new MemberWriteError(403, `only an admin or the member may change "${key}"`);
		}
		if (f.type === 'url' && typeof value === 'string' && value.trim()) {
			const c = checkProfileUrl(value);
			if (!c.ok) throw new MemberWriteError(400, `${f.label} ${c.reason}`, key);
			out[key] = c.url;
		}
	}
	return out;
}

// The patch folded into the member's current values. Empty text removes the
// key, as no stored value is ever empty. A checkbox is stored "TRUE"/"FALSE",
// the encoding every reader already accepts, and one that reads the same as
// its current value (an absent box reads unticked) is not a change, so a save
// that touched nothing rewrites nothing. A key in `exact` compares stored
// bytes rather than trimmed text: its patch value is already normalized (a
// checked URL), and a stored copy that only trims to it, such as one led by a
// no-break space, does not resolve to the same place and must be replaced.
export function computeDelta(
	current: Record<string, unknown>,
	patch: Patch,
	exact: ReadonlySet<string> = new Set()
): { next: Record<string, unknown>; changed: string[] } {
	const next: Record<string, unknown> = { ...current };
	const changed: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		const was = asText(ownValue(next, key));
		if (typeof value === 'boolean') {
			if (isChecked(was) === value) continue;
			next[key] = value ? 'TRUE' : 'FALSE';
		} else {
			const v = value.trim();
			if ((exact.has(key) ? was : was.trim()) === v) continue;
			if (v) next[key] = v;
			else delete next[key];
		}
		changed.push(key);
	}
	return { next, changed };
}

// A whole record in stored form, for a row that has no current values to
// compare against: every checkbox is stored, ticked or not, so the row says
// what was answered.
export function encodeValues(values: Patch): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'boolean') out[key] = value ? 'TRUE' : 'FALSE';
		else if (value.trim()) out[key] = value.trim();
	}
	return out;
}

// The typed columns, each joined from the fields naming it. `name` is never a
// value of its own, so there is nothing to edit apart from its fields. It
// stays an ordinary column rather than a generated one: a generated column
// would hardwire key names into the table, and each skin picks its own. A column is rebuilt only when this write changed one of its
// fields; otherwise it keeps what it holds, which may predate the parts (a
// sheet row that carried one "Full Name"), and an edit to Bio must not
// rewrite a name.
export function deriveColumns(
	next: Record<string, unknown>,
	changed: readonly string[],
	prev: Partial<Record<Typed, string | null>> = {},
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): Record<Typed, string | null> {
	const touched = new Set(changed);
	const sources: Record<Typed, string[]> = {
		name: promotedKeys('name', schema),
		city: promotedKeys('city', schema),
		linkedin: promotedKeys('linkedin', schema)
	};
	const out = {} as Record<Typed, string | null>;
	for (const c of ['name', 'city', 'linkedin'] as const) {
		const keys = sources[c];
		out[c] = keys.some((k) => touched.has(k))
			? keys
					.map((k) => asText(ownValue(next, k)).trim())
					.filter(Boolean)
					.join(' ') || null
			: (prev[c] ?? null);
	}
	return out;
}

// Before/after for the changed keys, with every non-members field (private,
// or an unmapped x.* column) reduced to set/empty unless the operator turned
// on AUDIT_RECORD_PRIVATE_VALUES.
export function auditDiff(
	changed: readonly string[],
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	recordPrivateValues: boolean,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
) {
	const shared = new Set(schema.filter((f) => f.visibility === 'members').map((f) => f.key));
	const text = (d: Record<string, unknown>) =>
		Object.fromEntries(changed.map((k) => [k, asText(ownValue(d, k))]));
	return diffFields(
		changed.map((k) => ({ name: k, private: !shared.has(k) })),
		text(before),
		text(after),
		recordPrivateValues
	);
}

export function isSelf(row: Pick<LockedRow, 'email' | 'ident_subject'>, actor: Actor): boolean {
	if (row.ident_subject && actor.actorSubject && row.ident_subject === actor.actorSubject) {
		return true;
	}
	return !!(
		actor.actorEmail &&
		row.email &&
		actor.actorEmail.toLowerCase() === row.email.toLowerCase()
	);
}

// ---------------------------------------------------------------------------
// Transactional mutations. Each runs on the caller's client, inside the
// caller's transaction.
// ---------------------------------------------------------------------------

type Common = {
	group: GroupRef;
	actor: Actor;
	recordPrivateValues: boolean;
};

export type UpdateInput = Common & {
	memberId: string;
	patch: Patch;
	authority: Authority;
	writer: 'form' | 'system';
	allow?: readonly string[];
};

// Returns the number of fields changed; 0 writes nothing and audits nothing.
export async function updateMemberIn(client: Client, u: UpdateInput): Promise<number> {
	await client.query(GROUP_LOCK_SQL, [u.group.id]);
	const { rows } = await client.query<LockedRow>(SELECT_FOR_UPDATE_SQL, [u.group.id, u.memberId]);
	const row = rows[0];
	if (!row) throw new MemberWriteError(404, 'this profile no longer exists');

	const patch = validatePatch(u.patch, {
		writer: u.writer,
		allow: u.allow,
		mayWritePrivate: u.authority.admin || isSelf(row, u.actor)
	});

	const current = { ...(row.private_data ?? {}), ...(row.data ?? {}) };
	// Only URL keys the caller submitted take part. An omitted one keeps both
	// stored copies, even where they disagree, because nothing this write was
	// given says which is right; fieldsFor returns the whole schema, so the
	// own-key test is what keeps an avatar write from rebuilding a website.
	const urlKeys = fieldsFor(Object.keys(patch), DEFAULT_FIELD_SCHEMA)
		.filter((f) => f.type === 'url' && Object.hasOwn(patch, f.key))
		.map((f) => f.key);
	const exact = new Set(urlKeys.filter((k) => String(patch[k]).trim() !== ''));
	const { next, changed } = computeDelta(current, patch, exact);
	// A typed column copied from a submitted URL field is rebuilt when its
	// stored bytes differ from what the submission leaves, even when the JSON
	// already matched: a checked value replaces a legacy spelling, and an
	// explicit clear empties a column whose JSON source was already gone.
	const rebuilt = deriveColumns(next, urlKeys, row);
	for (const c of ['name', 'city', 'linkedin'] as const) {
		if (rebuilt[c] === (row[c] ?? null)) continue;
		for (const k of promotedKeys(c, DEFAULT_FIELD_SCHEMA)) {
			if (urlKeys.includes(k) && !changed.includes(k)) changed.push(k);
		}
	}
	if (!changed.length) return 0;

	const typed = deriveColumns(next, changed, row);
	const stored = splitData(next);
	await client.query(UPDATE_SQL, [
		u.group.id,
		u.memberId,
		JSON.stringify(stored.data),
		JSON.stringify(stored.privateData),
		typed.name,
		typed.city,
		typed.linkedin
	]);
	const diff = auditDiff(changed, current, next, u.recordPrivateValues);
	await auditIn(client, {
		...u.actor,
		category: 'data',
		action: 'member.updated',
		groupId: u.group.id,
		groupSlug: u.group.slug,
		targetEmail: row.email,
		targetSubject: row.ident_subject,
		targetId: u.memberId,
		before: diff.before,
		after: diff.after,
		meta: diff.redacted.length ? { redacted: diff.redacted } : {}
	});
	return changed.length;
}

export type CreateInput = Common & {
	email: string;
	values: Patch;
	meta?: Record<string, unknown>;
};

// An address that is already an active member keeps its profile and gets null
// back; a removed one is reactivated with these values.
export async function createMemberIn(client: Client, c: CreateInput): Promise<string | null> {
	await client.query(GROUP_LOCK_SQL, [c.group.id]);
	const values = validatePatch(c.values, { writer: 'system', mayWritePrivate: true });
	const next = encodeValues(values);
	const changed = Object.keys(next);
	const typed = deriveColumns(next, changed);
	const stored = splitData(next);
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO member (group_id, email, name, city, linkedin, data, private_data, status)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'active')
		 ON CONFLICT (group_id, email) DO UPDATE SET
		   name = EXCLUDED.name,
		   city = EXCLUDED.city,
		   linkedin = EXCLUDED.linkedin,
		   data = EXCLUDED.data,
		   private_data = EXCLUDED.private_data,
		   status = 'active'
		 WHERE member.status <> 'active'
		 RETURNING id`,
		[
			c.group.id,
			c.email,
			typed.name,
			typed.city,
			typed.linkedin,
			JSON.stringify(stored.data),
			JSON.stringify(stored.privateData)
		]
	);
	const id = rows[0]?.id ?? null;
	if (!id) return null;
	const diff = auditDiff(changed, {}, next, c.recordPrivateValues);
	await auditIn(client, {
		...c.actor,
		category: 'membership',
		action: 'member.created',
		groupId: c.group.id,
		groupSlug: c.group.slug,
		targetEmail: c.email,
		targetId: id,
		after: diff.after,
		meta: { ...(c.meta ?? {}), ...(diff.redacted.length ? { redacted: diff.redacted } : {}) }
	});
	return id;
}

export type RemoveInput = { group: GroupRef; actor: Actor; memberId: string };

// The row stays, with status 'removed', so every reader that filters on
// 'active' stops seeing it and approval can reactivate it. False when no
// active member matched.
export async function softRemoveMemberIn(client: Client, r: RemoveInput): Promise<boolean> {
	await client.query(GROUP_LOCK_SQL, [r.group.id]);
	const { rows } = await client.query<LockedRow>(SELECT_FOR_UPDATE_SQL, [r.group.id, r.memberId]);
	const row = rows[0];
	if (!row) return false;
	await client.query(`UPDATE member SET status = 'removed' WHERE group_id = $1 AND id = $2`, [
		r.group.id,
		r.memberId
	]);
	await auditIn(client, {
		...r.actor,
		category: 'membership',
		action: 'member.removed',
		groupId: r.group.id,
		groupSlug: r.group.slug,
		targetEmail: row.email,
		targetSubject: row.ident_subject,
		targetId: r.memberId
	});
	return true;
}

export type BindInput = {
	groupId: string;
	memberId: string;
	email: string;
	subject: string;
	actor: Actor;
};

// First login: ties the OIDC subject to a member matched by email. The
// `ident_subject IS NULL` predicate makes the bind happen once. A concurrent
// login that bound first leaves this one with rowCount 0, nothing changed and
// nothing audited. True when this call bound it.
export async function bindSubjectIn(client: Client, b: BindInput): Promise<boolean> {
	await client.query(GROUP_LOCK_SQL, [b.groupId]);
	const { rowCount } = await client.query(
		`UPDATE member SET ident_subject = $1
		  WHERE group_id = $2 AND id = $3 AND ident_subject IS NULL`,
		[b.subject, b.groupId, b.memberId]
	);
	if (rowCount !== 1) return false;
	await auditIn(client, {
		...b.actor,
		category: 'authz',
		action: 'member.identity-bound',
		groupId: b.groupId,
		targetEmail: b.email,
		targetSubject: b.subject,
		targetId: b.memberId
	});
	return true;
}

// ---------------------------------------------------------------------------
// Bulk import. The import takes the group lock once, as the first statement of
// its transaction, then writes many rows under it; taking it per row would
// order nothing more. The writes below ask for the GroupLock that lockGroupIn
// returns rather than a bare client, so none of them can run on a transaction
// that skipped the lock. Values arrive already projected: the import decides
// bags and typed columns from the file's JSON kinds, which deriveColumns'
// text conversion does not preserve.
// ---------------------------------------------------------------------------

declare const heldLock: unique symbol;
export type GroupLock = {
	readonly [heldLock]: true;
	readonly client: Client;
	readonly groupId: string;
};

export async function lockGroupIn(client: Client, groupId: string): Promise<GroupLock> {
	await client.query(GROUP_LOCK_SQL, [groupId]);
	return { client, groupId } as GroupLock;
}

function lockedFor(lock: GroupLock, groupId: string): Client {
	if (lock.groupId !== groupId) {
		throw new Error(`holding the lock for group ${lock.groupId}, not ${groupId}`);
	}
	return lock.client;
}

export type ImportedRow = {
	data: Record<string, unknown>;
	privateData: Record<string, unknown>;
	name: string | null;
	city: string | null;
	linkedin: string | null;
};

// No ON CONFLICT: the import's diff matched every stored address, removed ones
// included, so a conflict here means the roster moved under the lock and the
// transaction should fail.
export async function importInsertIn(
	lock: GroupLock,
	groupId: string,
	email: string,
	row: ImportedRow
): Promise<string> {
	const { rows } = await lockedFor(lock, groupId).query<{ id: string }>(
		`INSERT INTO member (group_id, email, name, city, linkedin, data, private_data, status)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'active')
		 RETURNING id`,
		[
			groupId,
			email,
			row.name,
			row.city,
			row.linkedin,
			JSON.stringify(row.data),
			JSON.stringify(row.privateData)
		]
	);
	return rows[0].id;
}

// `status` null keeps the row's status.
export async function importUpdateIn(
	lock: GroupLock,
	groupId: string,
	memberId: string,
	row: ImportedRow,
	status: string | null
): Promise<void> {
	await lockedFor(lock, groupId).query(
		`UPDATE member
		    SET data = $3::jsonb, private_data = $4::jsonb, name = $5, city = $6, linkedin = $7,
		        status = coalesce($8, status)
		  WHERE group_id = $1 AND id = $2`,
		[
			groupId,
			memberId,
			JSON.stringify(row.data),
			JSON.stringify(row.privateData),
			row.name,
			row.city,
			row.linkedin,
			status
		]
	);
}

// Removal by set difference: every active member whose address is not among
// `keep`, plus those named in `remove`. It names the addresses it keeps rather
// than a time it started, so there is no run state to leave half-finished.
export async function importRemoveIn(
	lock: GroupLock,
	groupId: string,
	keep: readonly string[],
	remove: readonly string[]
): Promise<{ id: string; email: string }[]> {
	const { rows } = await lockedFor(lock, groupId).query<{ id: string; email: string }>(
		`UPDATE member SET status = 'removed'
		  WHERE group_id = $1 AND status = 'active'
		    AND (email <> ALL ($2::citext[]) OR email = ANY ($3::citext[]))
		  RETURNING id, email::text AS email`,
		[groupId, keep, remove]
	);
	return rows;
}

// Deletes the row outright; member_star rows naming it cascade. The audit row
// has no foreign key to member, so the record of the deletion outlives it.
// False when no row matched (a concurrent purge won), which writes nothing.
export async function hardPurgeMemberIn(client: Client, r: RemoveInput): Promise<boolean> {
	await client.query(GROUP_LOCK_SQL, [r.group.id]);
	const { rows } = await client.query<{ email: string; ident_subject: string | null }>(
		`DELETE FROM member WHERE group_id = $1 AND id = $2
		 RETURNING email::text AS email, ident_subject`,
		[r.group.id, r.memberId]
	);
	const row = rows[0];
	if (!row) return false;
	await auditIn(client, {
		...r.actor,
		category: 'membership',
		action: 'member.deleted',
		groupId: r.group.id,
		groupSlug: r.group.slug,
		targetEmail: row.email,
		targetSubject: row.ident_subject,
		targetId: r.memberId
	});
	return true;
}

// The sign-in address change (email-change-core.ts) moves one person's rows in
// several groups at once. Group locks first and in id order, then the rows, so
// it orders against saves and imports the way they order against each other,
// and two moves cannot deadlock. Then the identity lock, exclusively: every
// write that claims an address holds it shared (migration 21's triggers), so
// from here until commit no row anywhere can take or join an address.
const IDENTITY_MOVE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('identity-claim', 0))`;
export async function lockMembersIn(
	client: Client,
	memberIds: readonly string[]
): Promise<{ id: string; group_id: string; email: string }[]> {
	const { rows: groups } = await client.query<{ group_id: string }>(
		`SELECT DISTINCT group_id FROM member WHERE id = ANY($1::uuid[]) ORDER BY group_id`,
		[memberIds]
	);
	for (const g of groups) await client.query(GROUP_LOCK_SQL, [g.group_id]);
	await client.query(IDENTITY_MOVE_LOCK_SQL);
	const { rows } = await client.query<{ id: string; group_id: string; email: string }>(
		`SELECT id, group_id, email::text AS email FROM member
		  WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
		[memberIds]
	);
	return rows;
}

// Audited by the caller, which records one change per group with both addresses.
// Returns the rows' new identity_epoch, one value for the whole account.
export async function setAddressIn(
	client: Client,
	memberIds: readonly string[],
	email: string,
	subject: string
): Promise<string> {
	const { rows } = await client.query<{ epoch: string }>(
		`SELECT nextval('member_identity_epoch_seq')::text AS epoch`
	);
	await client.query(
		`UPDATE member SET email = $2, ident_subject = $3, identity_epoch = $4
		  WHERE id = ANY($1::uuid[])`,
		[memberIds, email, subject, rows[0].epoch]
	);
	return rows[0].epoch;
}

const usernameTaken = (field: string) => new MemberWriteError(409, 'that username is taken', field);

// Set, change or clear a member's username on the caller's transaction. `next`
// has already passed checkUsername (usernames.ts), or is null to clear. Every
// write to either table takes the group's member-write lock first, which is what
// keeps a name from being one member's current and another's retired; the lock
// is per transaction, so a caller already holding it takes it again for free.
// An empty value clears it and retires the old name. Returns whether anything
// changed.
export async function setUsernameIn(
	client: Client,
	u: { group: GroupRef; memberId: string; next: string | null; field: string; actor: Actor }
): Promise<boolean> {
	const next = u.next;
	await client.query(GROUP_LOCK_SQL, [u.group.id]);
	const { rows } = await client.query<{
		username: string | null;
		email: string;
		subject: string | null;
	}>(
		`SELECT username::text AS username, email::text AS email, ident_subject AS subject
		   FROM member WHERE group_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
		[u.group.id, u.memberId]
	);
	const row = rows[0];
	if (!row) throw new MemberWriteError(404, 'this profile no longer exists');
	const old = row.username;
	if (next === old) return false;

	if (next) {
		const held = await client.query(
			`SELECT 1 FROM member_username_retired
			  WHERE group_id = $1 AND username = $2 AND member_id <> $3`,
			[u.group.id, next, u.memberId]
		);
		if (held.rows.length) throw usernameTaken(u.field);
	}
	try {
		await client.query(`UPDATE member SET username = $3 WHERE group_id = $1 AND id = $2`, [
			u.group.id,
			u.memberId,
			next
		]);
	} catch (e) {
		if ((e as { code?: string }).code === '23505') throw usernameTaken(u.field);
		throw e;
	}
	if (next) {
		await client.query(
			`DELETE FROM member_username_retired
			  WHERE group_id = $1 AND username = $2 AND member_id = $3`,
			[u.group.id, next, u.memberId]
		);
	}
	if (old) {
		await client.query(
			`INSERT INTO member_username_retired (group_id, username, member_id)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (group_id, username) DO UPDATE SET retired_at = now()
			  WHERE member_username_retired.member_id = EXCLUDED.member_id`,
			[u.group.id, old, u.memberId]
		);
	}
	await auditIn(client, {
		...u.actor,
		category: 'data',
		action: 'member.updated',
		groupId: u.group.id,
		groupSlug: u.group.slug,
		targetEmail: row.email,
		targetSubject: row.subject,
		targetId: u.memberId,
		before: { username: old },
		after: { username: next },
		meta: {}
	});
	return true;
}
