// The roster import's SQL: the lock, the roster read, the stored plan, and the
// writes. No SvelteKit or $env, so scripts/import-members.ts runs it over its
// own pool. Every function runs on the caller's client inside the caller's
// transaction; the decisions are import-core.ts's.

import { randomUUID } from 'node:crypto';
import { auditIn, diffFields, type AuditEntry } from './audit-core';
import {
	isMembersVisibleKey,
	ownValue,
	promotedColumns,
	promotedKeys,
	splitData,
	type PromotedColumn
} from './field-schema';
import {
	canonical,
	diffDigest,
	diffImport,
	gateSatisfied,
	isPrivateKey,
	parseImport,
	removalGate,
	type ImportDiff,
	type ImportMode,
	type ImportRow,
	type RemovalGate,
	type RosterMember
} from './import-core';
import { JSON_CELL_PREFIX, STATUS_KEY, encodeCell, parseJsonExact } from './member-export';
import {
	importInsertIn,
	importRemoveIn,
	importUpdateIn,
	lockGroupIn,
	type Client,
	type GroupLock
} from './member-write-core';

export type Db = {
	query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
};

type GroupRef = { id: string; slug: string };
type Actor = Pick<AuditEntry, 'actorSubject' | 'actorEmail'>;
type AuditBase = Omit<AuditEntry, 'category' | 'action'>;

// The lock is member-write-core's group lock, the one every profile save,
// approval, sign-in bind and removal takes first. Transaction-scoped, so
// commit, rollback or a dead connection releases it and there is no state left
// behind to clear. A second key here would let a save and an import run
// side by side with nothing reporting it.
const lockRoster = (client: Db, groupId: string) => lockGroupIn(client as Client, groupId);

// What a single-member writer holds while it changes a row, for a test that
// stands in for a concurrent save. The name predates saves and imports
// sharing one key: the lock is the exclusive group lock, not a shared one.
export async function lockRosterShared(client: Db, groupId: string): Promise<void> {
	await lockRoster(client, groupId);
}

// ---------------------------------------------------------------------------
// The roster
// ---------------------------------------------------------------------------

type TypedColumn = Exclude<PromotedColumn, 'email'>;
const TYPED: readonly TypedColumn[] = ['name', 'city'];

export type StoredMember = RosterMember & Record<TypedColumn, string | null>;

// Both bags as text through parseJsonExact, as the export reads them, so a
// number compares by the digits PostgreSQL holds.
export async function loadRoster(
	client: Db,
	groupId: string,
	opts: { forUpdate: boolean }
): Promise<StoredMember[]> {
	const { rows } = await client.query<{
		id: string;
		email: string;
		status: string;
		data: string | null;
		private_data: string | null;
		name: string | null;
		city: string | null;
	}>(
		`SELECT id, email::text AS email, status, data::text AS data,
		        private_data::text AS private_data, name, city
		   FROM member
		  WHERE group_id = $1
		  ORDER BY lower(email), id${opts.forUpdate ? '\n\t\t  FOR UPDATE' : ''}`,
		[groupId]
	);
	const bag = (t: string | null) =>
		t === null ? {} : (parseJsonExact(t) as Record<string, unknown>);
	return rows.map((r) => ({
		id: r.id,
		email: r.email,
		status: r.status,
		data: bag(r.data),
		privateData: bag(r.private_data),
		name: r.name,
		city: r.city
	}));
}

function storedKeys(roster: readonly RosterMember[]): Set<string> {
	const keys = new Set<string>();
	for (const m of roster) {
		for (const k of Object.keys(m.data)) keys.add(k);
		for (const k of Object.keys(m.privateData)) keys.add(k);
	}
	return keys;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export const PLAN_TTL_MINUTES = 60;

export type ImportSummary = {
	diff: ImportDiff;
	gate: RemovalGate;
	digest: string;
	warnings: string[];
};

export type PreviewResult =
	| { ok: false; errors: string[]; warnings: string[] }
	| (ImportSummary & { ok: true; planId: string | null });

// Parse, validate, diff, and store the plan the admin is about to read. A
// refused plan (an empty file, removals past half) is shown but not stored,
// since nothing could ever apply it.
export async function previewImport(
	client: Db,
	group: GroupRef,
	actor: Actor,
	input: { text: string; mode: ImportMode; confirmPercent: number }
): Promise<PreviewResult> {
	const roster = await loadRoster(client, group.id, { forUpdate: false });
	const parsed = parseImport(input.text, { mode: input.mode, storedKeys: storedKeys(roster) });
	if (parsed.errors.length) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
	const diff = diffImport(parsed, roster, input.mode);
	if (diff.errors.length) return { ok: false, errors: diff.errors, warnings: parsed.warnings };
	const gate = removalGate(diff, input.confirmPercent, group.slug);
	const digest = diffDigest(diff);
	const summary = { diff, gate, digest, warnings: parsed.warnings };
	if (gate.kind === 'refused') return { ok: true, planId: null, ...summary };

	await client.query(
		`DELETE FROM member_import_plan WHERE created_at < now() - make_interval(mins => $1)`,
		[PLAN_TTL_MINUTES]
	);
	// The rows go in as one jsonb string holding their JSON, not as a jsonb
	// array: jsonb normalizes what it parses (key order, 1e2 as 100), and apply
	// must recompute the diff from the same values the digest was taken over.
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO member_import_plan (group_id, created_by, mode, keys, rows, digest)
		 VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
		 RETURNING id`,
		[
			group.id,
			actor.actorSubject ?? '',
			input.mode,
			JSON.stringify(parsed.keys),
			JSON.stringify(JSON.stringify(parsed.rows)),
			digest
		]
	);
	return { ok: true, planId: rows[0].id, ...summary };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type ApplyResult =
	| { ok: false; message: string }
	| { ok: true; runId: string; added: number; changed: number; removed: number; unchanged: number };

const DRIFTED =
	'The directory changed after this preview was made, so what you read is no longer what would happen. Nothing was changed. Upload the file again to see the new preview.';
const EXPIRED =
	'This preview has expired or was already applied. Nothing was changed. Upload the file again.';

// The lock is the first statement, before the plan is even read: everything
// after it sees a roster no other import or profile save can move. The diff is
// recomputed from the stored rows against that roster, and applied only when
// it hashes to the digest the admin was shown.
export async function applyImportPlan(
	client: Db,
	group: GroupRef,
	actor: Actor,
	input: { planId: string; digest: string; typed: string | null; confirmPercent: number },
	opts: { recordPrivateValues: boolean }
): Promise<ApplyResult> {
	const lock = await lockRoster(client, group.id);
	const { rows: plans } = await client.query<{
		mode: ImportMode;
		keys: string;
		rows: string;
		digest: string;
	}>(
		`SELECT mode, keys::text AS keys, rows #>> '{}' AS rows, digest
		   FROM member_import_plan
		  WHERE id = $1 AND group_id = $2 AND created_by = $3
		    AND created_at >= now() - make_interval(mins => $4)`,
		[input.planId, group.id, actor.actorSubject ?? '', PLAN_TTL_MINUTES]
	);
	const plan = plans[0];
	if (!plan) return { ok: false, message: EXPIRED };
	if (plan.digest !== input.digest) return { ok: false, message: DRIFTED };

	const roster = await loadRoster(client, group.id, { forUpdate: true });
	const parsed = {
		keys: parseJsonExact(plan.keys) as string[],
		rows: parseJsonExact(plan.rows) as ImportRow[]
	};
	const diff = diffImport(parsed, roster, plan.mode);
	if (diff.errors.length || diffDigest(diff) !== input.digest)
		return { ok: false, message: DRIFTED };

	const gate = removalGate(diff, input.confirmPercent, group.slug);
	if (gate.kind === 'refused') return { ok: false, message: gate.message };
	if (!gateSatisfied(gate, input.typed)) {
		return {
			ok: false,
			message: `Type ${gate.kind === 'typed' ? gate.count : ''}, the number of members this removes, to confirm. Nothing was changed.`
		};
	}

	await writeDiff(client, lock, group, actor, diff, roster, {
		runId: input.planId,
		fileEmails: parsed.rows.map((r) => r.email),
		recordPrivateValues: opts.recordPrivateValues,
		channel: 'admin'
	});
	await client.query('DELETE FROM member_import_plan WHERE id = $1', [input.planId]);
	return {
		ok: true,
		runId: input.planId,
		added: diff.added.length,
		changed: diff.changed.length,
		removed: diff.removed.length,
		unchanged: diff.unchanged
	};
}

// The operator's path, for what the browser refuses: removals past half the
// roster. One transaction, lock first, the diff computed under it, so there is
// no preview to drift from. Every removal needs its count passed back, and an
// empty file is refused here as well.
export async function runImport(
	client: Db,
	group: GroupRef,
	actor: Actor,
	input: {
		text: string;
		mode: ImportMode;
		apply: boolean;
		confirmRemovals: number | null;
		recordPrivateValues: boolean;
	}
): Promise<
	| (ImportSummary & { ok: true; applied: boolean; runId: string | null })
	| { ok: false; errors: string[]; warnings: string[] }
> {
	const lock = await lockRoster(client, group.id);
	const roster = await loadRoster(client, group.id, { forUpdate: true });
	const parsed = parseImport(input.text, {
		mode: input.mode,
		storedKeys: storedKeys(roster),
		maxRows: Number.MAX_SAFE_INTEGER
	});
	if (parsed.errors.length) return { ok: false, errors: parsed.errors, warnings: parsed.warnings };
	const diff = diffImport(parsed, roster, input.mode);
	if (diff.errors.length) return { ok: false, errors: diff.errors, warnings: parsed.warnings };
	const gate = removalGate(diff, 0, group.slug);
	const summary = { diff, gate, digest: diffDigest(diff), warnings: parsed.warnings };
	if (!input.apply) return { ok: true, applied: false, runId: null, ...summary };

	if (gate.kind === 'refused' && gate.reason === 'empty-file') {
		return { ok: false, errors: [gate.message], warnings: parsed.warnings };
	}
	if (diff.removed.length && input.confirmRemovals !== diff.removed.length) {
		return {
			ok: false,
			errors: [
				`This removes ${diff.removed.length} member(s). Pass --confirm-removals ${diff.removed.length} to apply it.`
			],
			warnings: parsed.warnings
		};
	}
	const runId = randomUUID();
	await writeDiff(client, lock, group, actor, diff, roster, {
		runId,
		fileEmails: parsed.rows.map((r) => r.email),
		recordPrivateValues: input.recordPrivateValues,
		channel: 'cli'
	});
	return { ok: true, applied: true, runId, ...summary };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const toStored = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

// The typed columns named, from only the fields that feed them, so a value in
// an unrelated field is never read. Each value reduces to the text String()
// gives an ordinary JSON value, computed by its JSON kind instead: a JSON.rawJSON
// number at any depth contributes its own digits rather than a rounded Number,
// and an object's own "toString" or "valueOf" key is data, never a conversion
// hook String() would call.
function typedColumns(
	values: Record<string, unknown>,
	cols: readonly TypedColumn[]
): Record<TypedColumn, string | null> {
	const plain = Object.fromEntries(
		cols
			.flatMap((c) => promotedKeys(c))
			.map((k) => [k, ownValue(values, k) == null ? null : columnText(ownValue(values, k))])
	);
	const all = promotedColumns(plain);
	return Object.fromEntries(cols.map((c) => [c, all[c]])) as Record<TypedColumn, string | null>;
}

function columnText(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	if (typeof v === 'boolean' || typeof v === 'number') return String(v);
	if (JSON.isRawJSON(v)) return JSON.stringify(v);
	if (Array.isArray(v)) return v.map(columnText).join(',');
	return '[object Object]';
}

// The audit records a value in the export's cell notation, so text "true" and
// boolean json:true stay distinct. Two values get the same text here exactly
// when import-core's comparable() calls them equal, which diffFields relies on:
// it drops a field whose before and after texts match, and a field the import
// changed must never be dropped. Empty stays '' so a cleared private field
// still redacts as <empty>.
function auditText(values: Record<string, unknown>, keys: string[]): Record<string, string> {
	return Object.fromEntries(keys.map((k) => [k, auditValue(ownValue(values, k))]));
}

function auditValue(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string') return encodeCell(v.trim());
	return JSON_CELL_PREFIX + canonical(v);
}

async function writeDiff(
	client: Db,
	lock: GroupLock,
	group: GroupRef,
	actor: Actor,
	diff: ImportDiff,
	roster: readonly StoredMember[],
	opts: {
		runId: string;
		fileEmails: string[];
		recordPrivateValues: boolean;
		channel: 'admin' | 'cli';
	}
): Promise<void> {
	const base: AuditBase = { ...actor, groupId: group.id, groupSlug: group.slug, runId: opts.runId };
	const specs = (keys: string[]) => keys.map((k) => ({ name: k, private: isPrivateKey(k) }));
	const fieldAudit = (
		keys: string[],
		before: Record<string, unknown>,
		after: Record<string, unknown>
	) => {
		const d = diffFields(
			specs(keys),
			auditText(before, keys),
			auditText(after, keys),
			opts.recordPrivateValues
		);
		return {
			before: d.before,
			after: d.after,
			meta: d.redacted.length ? { redacted: d.redacted } : {}
		};
	};

	for (const a of diff.added) {
		const values = Object.fromEntries(Object.entries(a.values).map(([k, v]) => [k, toStored(v)]));
		const typed = typedColumns(values, TYPED);
		const stored = splitData(values);
		const id = await importInsertIn(lock, group.id, a.email.trim(), {
			...typed,
			data: stored.data,
			privateData: stored.privateData
		});
		await auditIn(client, {
			...base,
			category: 'data',
			action: 'member.import-added',
			targetEmail: a.email.trim(),
			targetId: id,
			...fieldAudit(Object.keys(values), {}, values)
		});
	}

	const byId = new Map(roster.map((m) => [m.id, m]));
	for (const c of diff.changed) {
		const m = byId.get(c.id)!;
		// Only the keys the diff names move. Every other key stays in the bag it
		// is in, even where the schema would route it elsewhere today: an import
		// is not a migration, and the preview did not show that move.
		const data = { ...m.data };
		const privateData = { ...m.privateData };
		const values: Record<string, unknown> = { ...m.privateData, ...m.data };
		const before = { ...values, [STATUS_KEY]: m.status };
		let status: string | null = null;
		for (const ch of c.changes) {
			if (ch.key === STATUS_KEY) {
				status = String(ch.after);
				continue;
			}
			delete data[ch.key];
			delete privateData[ch.key];
			delete values[ch.key];
			if (canonical(ch.after) === '') continue;
			const v = toStored(ch.after);
			values[ch.key] = v;
			(isMembersVisibleKey(ch.key) ? data : privateData)[ch.key] = v;
		}
		// A typed column is rebuilt only when one of its fields changed, as a
		// profile save does: it may predate the stored fields.
		const touched = new Set(c.changes.map((x) => x.key));
		const rebuild = TYPED.filter((col) => promotedKeys(col).some((k) => touched.has(k)));
		const rebuilt = typedColumns(values, rebuild);
		const typed = Object.fromEntries(
			TYPED.map((col) => [col, rebuild.includes(col) ? rebuilt[col] : m[col]])
		) as Record<TypedColumn, string | null>;
		await importUpdateIn(lock, group.id, m.id, { ...typed, data, privateData }, status);
		const after = { ...values, [STATUS_KEY]: status ?? m.status };
		await auditIn(client, {
			...base,
			category: 'data',
			action: 'member.import-updated',
			targetEmail: m.email,
			targetId: m.id,
			...fieldAudit([...touched], before, after)
		});
	}

	if (diff.mode === 'replace') await removeAbsent(client, lock, group, diff, opts.fileEmails, base);

	await auditIn(client, {
		...base,
		category: 'data',
		action: 'members.import',
		meta: {
			mode: diff.mode,
			channel: opts.channel,
			rows: diff.rows,
			added: diff.added.length,
			changed: diff.changed.length,
			removed: diff.removed.length,
			unchanged: diff.unchanged,
			digest: diffDigest(diff)
		}
	});
}

// The only removal an import performs, and only in replace mode: the set
// difference between the active roster and the file's addresses, plus rows the
// file marks removed. It must remove exactly the members the admin was shown,
// or the transaction rolls back.
async function removeAbsent(
	client: Db,
	lock: GroupLock,
	group: GroupRef,
	diff: ImportDiff,
	fileEmails: string[],
	base: AuditBase
): Promise<void> {
	if (fileEmails.length === 0) throw new Error('refusing a replace with no member rows');
	const byStatus = diff.removed.filter((r) => r.via === 'status').map((r) => r.email);
	const rows = await importRemoveIn(lock, group.id, fileEmails, byStatus);
	const planned = new Set(diff.removed.map((r) => r.id));
	if (rows.length !== planned.size || rows.some((r) => !planned.has(r.id))) {
		throw new Error(
			`the removal matched ${rows.length} member(s) where the preview showed ${planned.size}; rolled back`
		);
	}
	const via = new Map(diff.removed.map((r) => [r.id, r.via]));
	for (const r of rows) {
		await auditIn(client, {
			...base,
			category: 'data',
			action: 'member.import-removed',
			targetEmail: r.email,
			targetId: r.id,
			before: { [STATUS_KEY]: 'active' },
			after: { [STATUS_KEY]: 'removed' },
			meta: { via: via.get(r.id) }
		});
	}
}
