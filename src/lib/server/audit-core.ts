// Pure audit engine: the INSERT, its parameters, the prune and the redaction
// rules. No SvelteKit or $env imports, so a script can write and prune audit
// rows over its own pool. audit.ts binds this to the app's pool and $env.

import type pg from 'pg';
import { redactRecord } from './redact';

// Category picks the retention window and nothing else. `authz` outlives the
// rest because "who granted this person access, and when" is what an incident
// turns on, and it is unanswerable once it has aged out.
export type AuditCategory = 'authz' | 'membership' | 'content' | 'data' | 'system';

export type AuditEntry = {
	category: AuditCategory;
	action: string;
	actorSubject?: string | null;
	actorEmail?: string | null;
	groupId?: string | null;
	groupSlug?: string | null;
	targetEmail?: string | null;
	targetSubject?: string | null;
	targetId?: string | null;
	before?: Record<string, unknown> | null;
	after?: Record<string, unknown> | null;
	meta?: Record<string, unknown>;
	runId?: string | null;
};

export type Queryable = {
	query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
};

export const AUDIT_INSERT_SQL = `INSERT INTO audit_event
	(category, action, actor_subject, actor_email, group_id, group_slug,
	 target_email, target_subject, target_id, before, after, meta, run_id)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)`;

// before/after/meta pass through the logger's scrubber, so a credential or an
// address under a denied key is digested here exactly as it would be in a log
// line. The target columns are not scrubbed: filtering by who was acted on is
// what the trail is for.
//
// The one exception is a presence marker under a field `meta.redacted` names:
// diffFields already replaced that value, and SET/EMPTY carry nothing but the
// presence the reader needs. Digesting a marker because the field happens to be
// called `email` would leave a cleared field indistinguishable from an edited
// one. Anything else under that key, including a raw value, is still scrubbed.
export function auditParams(e: AuditEntry): unknown[] {
	const marked = new Set(
		Array.isArray(e.meta?.redacted) ? e.meta.redacted.filter((k) => typeof k === 'string') : []
	);
	const json = (v: Record<string, unknown> | null | undefined) => {
		if (v == null) return null;
		const out = redactRecord(v);
		for (const k of marked) {
			if (Object.hasOwn(v, k) && (v[k] === SET || v[k] === EMPTY)) out[k] = v[k];
		}
		return JSON.stringify(out);
	};
	return [
		e.category,
		e.action,
		e.actorSubject ?? null,
		e.actorEmail ?? null,
		e.groupId ?? null,
		e.groupSlug ?? null,
		e.targetEmail ?? null,
		e.targetSubject ?? null,
		e.targetId ?? null,
		json(e.before),
		json(e.after),
		JSON.stringify(redactRecord(e.meta ?? {})),
		e.runId ?? null
	];
}

export function actorOf(
	user: { subject?: string | null; email?: string | null } | null | undefined
): { actorSubject: string | null; actorEmail: string | null } {
	return { actorSubject: user?.subject ?? null, actorEmail: user?.email ?? null };
}

// The transactional entry point. Runs on the caller's client, inside the
// caller's transaction, and throws: a state change and its record commit
// together or neither does.
export async function auditIn(client: Queryable, entry: AuditEntry): Promise<void> {
	await client.query(AUDIT_INSERT_SQL, auditParams(entry));
}

// The best-effort entry point, for observations with no transaction to join.
// Nothing escapes it, not even a throw from building the parameters: an audit
// write must never be able to fail a page view.
export async function auditBestEffort(
	db: Queryable,
	entry: AuditEntry,
	onError: (e: unknown) => void
): Promise<void> {
	try {
		await db.query(AUDIT_INSERT_SQL, auditParams(entry));
	} catch (e) {
		try {
			onError(e);
		} catch {
			// a failing logger is still not the caller's problem
		}
	}
}

export type AuditConfig = {
	/** Days to keep every category but authz. 0 keeps forever. */
	retentionDays: number;
	/** Days to keep authz. 0 keeps forever. */
	retentionDaysAuthz: number;
	/** Record private field values instead of set/empty markers. */
	recordPrivateValues: boolean;
};

function days(raw: string | undefined, fallback: number, name: string): number {
	if (raw == null || raw.trim() === '') return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		throw new Error(`${name} must be a whole number of days, 0 for forever; got "${raw}"`);
	}
	return n;
}

export function parseAuditConfig(env: Record<string, string | undefined>): AuditConfig {
	return {
		retentionDays: days(env.AUDIT_RETENTION_DAYS, 90, 'AUDIT_RETENTION_DAYS'),
		retentionDaysAuthz: days(env.AUDIT_RETENTION_DAYS_AUTHZ, 365, 'AUDIT_RETENTION_DAYS_AUTHZ'),
		recordPrivateValues: recordPrivateValuesFrom(env)
	};
}

// Read on its own so a mutation never depends on the retention settings parsing:
// a mistyped AUDIT_RETENTION_DAYS is the pruner's problem, not a profile save's.
export function recordPrivateValuesFrom(env: Record<string, string | undefined>): boolean {
	return /^(1|true|yes|on)$/i.test(env.AUDIT_RECORD_PRIVATE_VALUES ?? '');
}

// ---------------------------------------------------------------------------
// Redaction of field values
// ---------------------------------------------------------------------------

export const SET = '<set>';
export const EMPTY = '<empty>';

export type FieldDiff = {
	before: Record<string, string>;
	after: Record<string, string>;
	/** Names whose values were replaced by SET/EMPTY markers. */
	redacted: string[];
};

// Only the fields that changed. A private field records that it changed and
// whether it is now set, never the value: the value would be a second copy of
// the most sensitive data in the system, on a different retention clock, behind
// a different access path, outliving the member row it was copied from.
export function diffFields(
	specs: { name: string; private?: boolean }[],
	before: Record<string, string>,
	after: Record<string, string | undefined>,
	recordPrivateValues: boolean
): FieldDiff {
	const out: FieldDiff = { before: {}, after: {}, redacted: [] };
	for (const f of specs) {
		const next = Object.hasOwn(after, f.name) ? after[f.name] : undefined;
		if (next === undefined) continue;
		const prev = (Object.hasOwn(before, f.name) ? before[f.name] : undefined) ?? '';
		if (prev.trim() === next.trim()) continue;
		if (f.private && !recordPrivateValues) {
			out.before[f.name] = prev.trim() ? SET : EMPTY;
			out.after[f.name] = next.trim() ? SET : EMPTY;
			out.redacted.push(f.name);
		} else {
			out.before[f.name] = prev;
			out.after[f.name] = next;
		}
	}
	return out;
}

export const TEXT_MAX = 2000;

// Long free text (the landing page) is recorded up to TEXT_MAX with its full
// length beside it, so the row says how big the change was without becoming a
// second content store.
export function clipText(
	text: string | null,
	max = TEXT_MAX
): { text: string | null; length: number; truncated: boolean } {
	const s = text ?? '';
	return {
		text: text == null ? null : s.slice(0, max),
		length: s.length,
		truncated: s.length > max
	};
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

// Distinct from the migration lock in migrations.ts. Don't change it.
const PRUNE_LOCK_KEY = 4_607_002;

export const PRUNE_BATCH = 1000;

// One bounded DELETE. A NULL cutoff disables its half, which is how 0 (forever)
// reaches SQL. The LIMIT keeps the first prune on a large table from holding one
// long transaction; the caller repeats the statement until a batch comes back
// short.
export const PRUNE_SQL = `DELETE FROM audit_event WHERE id IN (
	SELECT id FROM audit_event
	 WHERE (category <> 'authz' AND $1::timestamptz IS NOT NULL AND at < $1::timestamptz)
	    OR (category = 'authz' AND $2::timestamptz IS NOT NULL AND at < $2::timestamptz)
	 LIMIT $3)`;

export function pruneParams(cfg: AuditConfig, now: Date, batch = PRUNE_BATCH): unknown[] {
	const cutoff = (d: number) => (d > 0 ? new Date(now.getTime() - d * 86_400_000) : null);
	return [cutoff(cfg.retentionDays), cutoff(cfg.retentionDaysAuthz), batch];
}

export type PruneResult = { skipped: boolean; deleted: number; batches: number };

// Shared by the in-process timer and the `prune` compose profile. Not audited:
// a prune that wrote a row would keep the table from ever emptying, and the
// caller logs the result instead.
//
// pg_try_advisory_lock, not pg_advisory_lock: with N replicas one prunes and
// the rest skip immediately rather than queueing to repeat the same work.
export async function pruneAudit(
	pool: Pick<pg.Pool, 'connect'>,
	cfg: AuditConfig,
	opts: { now?: Date; batch?: number; maxBatches?: number } = {}
): Promise<PruneResult> {
	if (cfg.retentionDays === 0 && cfg.retentionDaysAuthz === 0) {
		return { skipped: false, deleted: 0, batches: 0 };
	}
	const batch = opts.batch ?? PRUNE_BATCH;
	const maxBatches = opts.maxBatches ?? 10_000;
	const client = await pool.connect();
	try {
		const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
			PRUNE_LOCK_KEY
		]);
		if (!lock.rows[0]?.ok) return { skipped: true, deleted: 0, batches: 0 };
		try {
			const params = pruneParams(cfg, opts.now ?? new Date(), batch);
			let deleted = 0;
			let batches = 0;
			while (batches < maxBatches) {
				const res = await client.query(PRUNE_SQL, params);
				batches += 1;
				deleted += res.rowCount ?? 0;
				if ((res.rowCount ?? 0) < batch) break;
			}
			return { skipped: false, deleted, batches };
		} finally {
			await client.query('SELECT pg_advisory_unlock($1)', [PRUNE_LOCK_KEY]);
		}
	} finally {
		client.release();
	}
}

export const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
export const PRUNE_FIRST_MS = 5 * 60 * 1000;

// A jittered first run, then a jittered interval, so N replicas booted together
// do not all reach for the lock at once. Both timers are unref'd: a prune is
// never a reason for the process to stay up.
export function schedulePrune(
	run: () => Promise<void>,
	opts: { firstMs?: number; everyMs?: number; random?: () => number } = {}
): { timers: NodeJS.Timeout[]; stop(): void } {
	const firstMs = opts.firstMs ?? PRUNE_FIRST_MS;
	const everyMs = opts.everyMs ?? PRUNE_EVERY_MS;
	const random = opts.random ?? Math.random;
	const timers: NodeJS.Timeout[] = [];
	const first = setTimeout(
		() => {
			void run();
			timers.push(
				setInterval(() => void run(), everyMs + Math.floor(random() * (everyMs / 6))).unref()
			);
		},
		firstMs + Math.floor(random() * firstMs)
	).unref();
	timers.push(first);
	return {
		timers,
		stop: () => timers.forEach((t) => clearTimeout(t))
	};
}

type BootLog = {
	debug(msg: string, ctx: Record<string, unknown>): void;
	info(msg: string, ctx: Record<string, unknown>): void;
	error(msg: string, ctx: Record<string, unknown>): void;
};

// The boot half of retention: say loudly if private values are being recorded,
// then read the retention settings and start the timer. The warning comes
// first and reads its flag on its own, because a mutation records private
// values whether or not the retention settings parse. An unparseable retention
// setting starts nothing and says so, rather than guessing a window for a
// privacy control.
export function startPruner(
	pool: Pick<pg.Pool, 'connect'>,
	env: Record<string, string | undefined>,
	log: BootLog,
	schedule: typeof schedulePrune = schedulePrune
): ReturnType<typeof schedulePrune> | null {
	if (recordPrivateValuesFrom(env)) {
		log.error('audit.private-values.ENABLED', {
			warning:
				'AUDIT_RECORD_PRIVATE_VALUES is on: the audit trail is storing private member field values (postal address, phone, sizes) in clear. Turn it off unless you are debugging right now.'
		});
	}
	let cfg: AuditConfig;
	try {
		cfg = parseAuditConfig(env);
	} catch (e) {
		log.error('audit.config-invalid', { error: e as Error });
		return null;
	}
	return schedule(async () => {
		try {
			const r = await pruneAudit(pool, cfg);
			if (r.skipped) log.debug('audit.prune.skipped', { reason: 'another replica holds the lock' });
			else log.info('audit.prune.done', { deleted: r.deleted, batches: r.batches });
		} catch (e) {
			log.error('audit.prune.failed', { error: e as Error });
		}
	});
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES: AuditCategory[] = [
	'authz',
	'membership',
	'content',
	'data',
	'system'
];

export function isAuditCategory(v: string): v is AuditCategory {
	return (AUDIT_CATEGORIES as string[]).includes(v);
}

// Adjacent rows sharing a run_id fold into one block, so a sync that removed
// forty members reads as one entry with forty lines under it. Adjacency rather
// than a global group-by keeps the list in time order; a run split across a page
// boundary shows as two blocks, one per page.
export function groupByRun<T extends { runId: string | null }>(
	rows: T[]
): { runId: string | null; rows: T[] }[] {
	const out: { runId: string | null; rows: T[] }[] = [];
	for (const r of rows) {
		const last = out[out.length - 1];
		if (r.runId && last?.runId === r.runId) last.rows.push(r);
		else out.push({ runId: r.runId, rows: [r] });
	}
	return out;
}
