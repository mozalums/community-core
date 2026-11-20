import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import {
	auditBestEffort,
	auditIn,
	auditParams,
	clipText,
	diffFields,
	EMPTY,
	groupByRun,
	parseAuditConfig,
	pruneAudit,
	pruneParams,
	PRUNE_SQL,
	schedulePrune,
	SET,
	startPruner,
	type AuditConfig,
	type AuditEntry
} from './audit-core';
import { DENIED_FIXTURE, KEPT_FIXTURE, leakedValues } from './redact-fixture';
import { MIGRATIONS } from './migrations';

const ENTRY: AuditEntry = { category: 'content', action: 'probe', groupId: null };

// A real pool aimed at a port nothing listens on: "the database is down" as
// pg actually reports it, not as a stub imagines it.
function deadPool(): pg.Pool {
	return new pg.Pool({
		host: '127.0.0.1',
		port: 1,
		user: 'nobody',
		database: 'nothing',
		connectionTimeoutMillis: 1000,
		max: 1
	});
}

// ---------------------------------------------------------------------------
// Requirement 2: the two entry points
// ---------------------------------------------------------------------------

test('audit (best-effort) never throws with the database down, and reports why', async () => {
	const pool = deadPool();
	const seen: unknown[] = [];
	try {
		await auditBestEffort(pool, ENTRY, (e) => seen.push(e));
	} finally {
		await pool.end();
	}
	assert.equal(seen.length, 1, 'the failure was swallowed without being reported');
	assert.match(String((seen[0] as Error).message), /ECONNREFUSED|connect/i);
});

test('audit (best-effort) survives its own error reporter throwing', async () => {
	const pool = deadPool();
	try {
		await auditBestEffort(pool, ENTRY, () => {
			throw new Error('logger down too');
		});
	} finally {
		await pool.end();
	}
});

test('auditIn throws with the database down', async () => {
	const pool = deadPool();
	try {
		await assert.rejects(() => auditIn(pool, ENTRY));
	} finally {
		await pool.end();
	}
});

// A client that models what a transaction does with a write: anything inside
// BEGIN is staged, COMMIT publishes it, ROLLBACK discards it. `failInsert`
// makes the audit INSERT itself fail. `tx` is the BEGIN/COMMIT/ROLLBACK
// sequence withTransaction runs, so auditIn is driven the way a route drives it.
function txClient(failInsert = false) {
	const committed: string[] = [];
	let staged: string[] = [];
	const client = {
		query: async (text: string) => {
			const t = text.trim();
			if (t === 'COMMIT') {
				committed.push(...staged);
				staged = [];
			} else if (t === 'ROLLBACK') {
				staged = [];
			} else if (t !== 'BEGIN') {
				if (failInsert && t.startsWith('INSERT INTO audit_event'))
					throw new Error('relation "audit_event" does not exist');
				staged.push(t.startsWith('INSERT INTO audit_event') ? 'audit' : t);
			}
			return { rows: [], rowCount: 1 };
		}
	};
	const tx = async (fn: (c: typeof client) => Promise<void>) => {
		await client.query('BEGIN');
		try {
			await fn(client);
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK');
			throw e;
		}
	};
	return { client, tx, committed };
}

test('a rolled-back transaction leaves no audit row', async () => {
	const t = txClient();
	await assert.rejects(
		() =>
			t.tx(async (c) => {
				await auditIn(c, ENTRY);
				throw new Error('the update failed');
			}),
		/update failed/
	);
	assert.deepEqual(t.committed, [], 'the audit row outlived the change it describes');
});

test('a mutation cannot commit when its audit row cannot be written', async () => {
	const t = txClient(true);
	await assert.rejects(() =>
		t.tx(async (c) => {
			await c.query('UPDATE "group" SET landing_md = $2');
			await auditIn(c, ENTRY);
		})
	);
	assert.deepEqual(t.committed, [], 'the change committed with no record of it');
});

test('a successful mutation commits with its audit row', async () => {
	const t = txClient();
	await t.tx(async (c) => {
		await c.query('UPDATE "group" SET landing_md = $2');
		await auditIn(c, ENTRY);
	});
	assert.deepEqual(t.committed, ['UPDATE "group" SET landing_md = $2', 'audit']);
});

// No audit helper may wrap an external call: a transaction cannot span one, so
// a helper that did would publish an atomicity it cannot keep.
test('audit-core exports no wrapper that runs a callback inside an audit transaction', async () => {
	const core = await import('./audit-core');
	assert.equal('recordedOn' in core, false);
	assert.doesNotMatch(src('./audit-core.ts'), /BEGIN/);
});

// ---------------------------------------------------------------------------
// Requirement 4: the shared scrubber
// ---------------------------------------------------------------------------

test('the shared fixture: audit payloads redact the same keys the logger does', () => {
	const params = auditParams({
		...ENTRY,
		before: { ...DENIED_FIXTURE, ...KEPT_FIXTURE },
		after: { nested: { ...DENIED_FIXTURE } },
		meta: { ...DENIED_FIXTURE, ...KEPT_FIXTURE }
	});
	const out = JSON.stringify(params);
	assert.deepEqual(leakedValues(out), [], out);
	const before = JSON.parse(params[9] as string);
	for (const [k, v] of Object.entries(KEPT_FIXTURE)) assert.equal(before[k], v);
	for (const k of Object.keys(DENIED_FIXTURE)) assert.match(before[k], /^sha256:[0-9a-f]{12}$/);
});

test('presence markers under a field meta.redacted names survive the scrubber, nothing else does', () => {
	const RAW = 'member@example.org';
	const stored = (e: Partial<AuditEntry>) => {
		const p = auditParams({ ...ENTRY, ...e });
		return {
			before: JSON.parse(p[9] as string),
			after: JSON.parse(p[10] as string),
			meta: JSON.parse(p[11] as string)
		};
	};
	const digested = /^sha256:[0-9a-f]{12}$/;

	const listed = stored({
		before: { email: SET, token: EMPTY, Email: SET },
		after: { email: EMPTY, token: SET, Email: EMPTY },
		meta: { redacted: ['email', 'token'] }
	});
	assert.deepEqual(listed.before.email, SET);
	assert.deepEqual(listed.after.email, EMPTY);
	assert.deepEqual(listed.before.token, EMPTY);
	assert.deepEqual(listed.after.token, SET);
	assert.match(listed.before.Email, digested, 'the name match is exact, not folded');
	assert.deepEqual(listed.meta, { redacted: ['email', 'token'] });

	const raw = stored({
		before: { email: RAW, token: ` ${SET}`, other: { email: SET } },
		after: { email: { v: SET }, subject: SET },
		meta: { redacted: ['email', 'token', 'other'], email: RAW }
	});
	assert.match(raw.before.email, digested, 'a raw value under a listed key');
	assert.match(raw.before.token, digested, 'a padded marker is not a marker');
	assert.match(raw.before.other.email, digested, 'a nested key is not a listed field');
	assert.match(raw.after.email, digested, 'an object under a listed key');
	assert.match(raw.after.subject, digested, 'an unlisted marker');
	assert.match(raw.meta.email, digested, 'meta itself is still scrubbed');
	assert.ok(!JSON.stringify(raw).includes(RAW));

	for (const redacted of ['email', [7], null, { 0: 'email' }]) {
		const odd = stored({ after: { email: SET }, meta: { redacted } });
		assert.match(odd.after.email, digested, `meta.redacted = ${JSON.stringify(redacted)}`);
	}

	const inherited = stored({
		after: Object.create({ email: SET }) as Record<string, unknown>,
		meta: { redacted: ['email'] }
	});
	assert.deepEqual(inherited.after, {}, 'a prototype key is not an own field');

	const optIn = diffFields([{ name: 'email', private: true }], { email: '' }, { email: RAW }, true);
	const recorded = stored({ after: optIn.after, meta: optIn.redacted.length ? { redacted: optIn.redacted } : {} });
	assert.match(recorded.after.email, digested, 'opt-in values still meet the credential scrubber');
});

// ---------------------------------------------------------------------------
// Requirement 5: private values
// ---------------------------------------------------------------------------

const SPECS = [{ name: 'city' }, { name: 'postal', private: true }, { name: 'bio' }];
const ADDRESS = '12 Rue de la Paix, 75002 Paris';

test('a private field records set/empty, never its value', () => {
	const d = diffFields(
		SPECS,
		{ city: 'Paris', postal: ADDRESS, bio: 'same' },
		{ city: 'Lyon', postal: '', bio: 'same' },
		false
	);
	assert.deepEqual(d.before, { city: 'Paris', postal: SET });
	assert.deepEqual(d.after, { city: 'Lyon', postal: EMPTY });
	assert.deepEqual(d.redacted, ['postal']);
	assert.ok(!JSON.stringify(d).includes(ADDRESS));
});

test('AUDIT_RECORD_PRIVATE_VALUES records the value, and is off by default', () => {
	assert.equal(parseAuditConfig({}).recordPrivateValues, false);
	assert.equal(parseAuditConfig({ AUDIT_RECORD_PRIVATE_VALUES: 'true' }).recordPrivateValues, true);
	const d = diffFields(SPECS, { postal: '' }, { postal: ADDRESS }, true);
	assert.deepEqual(d.after, { postal: ADDRESS });
	assert.deepEqual(d.redacted, []);
});

test('set/empty markers survive serialization under a field name the scrubber denies', () => {
	const d = diffFields(
		[{ name: 'email', private: true }],
		{ email: 'old@example.com' },
		{ email: '' },
		false
	);
	const params = auditParams({
		...ENTRY,
		before: d.before,
		after: d.after,
		meta: { redacted: d.redacted }
	});
	assert.deepEqual(JSON.parse(params[9] as string), { email: SET });
	assert.deepEqual(JSON.parse(params[10] as string), { email: EMPTY });
	assert.deepEqual(JSON.parse(params[11] as string), { redacted: ['email'] });
	// Only a marker is spared: a raw value under the same name, or a marker under
	// a name meta.redacted does not list, is digested as before.
	const raw = auditParams({
		...ENTRY,
		before: { email: 'old@example.com', token: SET },
		after: { email: ADDRESS },
		meta: { redacted: ['email'] }
	});
	const out = JSON.stringify(raw);
	assert.ok(!out.includes('old@example.com') && !out.includes(ADDRESS), out);
	assert.match(JSON.parse(raw[9] as string).token, /^sha256:/);
	// Opt-in recording leaves redacted empty, so the raw value still meets the scrubber.
	const optIn = diffFields(
		[{ name: 'email', private: true }],
		{ email: '' },
		{ email: 'new@example.com' },
		true
	);
	const recorded = auditParams({ ...ENTRY, before: optIn.before, after: optIn.after, meta: {} });
	assert.match(JSON.parse(recorded[10] as string).email, /^sha256:/);
});

test('long text is clipped with its full length kept', () => {
	const c = clipText('x'.repeat(5000));
	assert.equal(c.text?.length, 2000);
	assert.equal(c.length, 5000);
	assert.equal(c.truncated, true);
	assert.deepEqual(clipText(null), { text: null, length: 0, truncated: false });
});

// ---------------------------------------------------------------------------
// Requirement 6: retention
// ---------------------------------------------------------------------------

test('retention defaults to 90 days and 365 for authz, and 0 means forever', () => {
	const d = parseAuditConfig({});
	assert.equal(d.retentionDays, 90);
	assert.equal(d.retentionDaysAuthz, 365);
	const now = new Date('2026-11-14T00:00:00Z');
	const [content, authz] = pruneParams(d, now) as [Date, Date];
	assert.equal(content.toISOString(), '2026-08-16T00:00:00.000Z');
	assert.equal(authz.toISOString(), '2025-11-14T00:00:00.000Z');
	const forever = pruneParams({ ...d, retentionDays: 0, retentionDaysAuthz: 0 }, now);
	assert.deepEqual(forever.slice(0, 2), [null, null]);
	assert.throws(() => parseAuditConfig({ AUDIT_RETENTION_DAYS: '-1' }), /AUDIT_RETENTION_DAYS/);
	assert.throws(() => parseAuditConfig({ AUDIT_RETENTION_DAYS_AUTHZ: 'a year' }));
});

type Row = { id: number; category: string; at: Date };

// Applies PRUNE_SQL's predicate to an in-memory table using the parameters the
// code actually sent. The SQL text itself is exercised against Postgres in
// audit-core.pg.test.ts; this proves the parameters and the batching.
function prunePool(table: Row[], opts: { locked?: boolean } = {}) {
	const deletes: unknown[][] = [];
	const statements: string[] = [];
	const client = {
		query: async (text: string, values: unknown[] = []) => {
			statements.push(text);
			if (/pg_try_advisory_lock/.test(text)) return { rows: [{ ok: !opts.locked }], rowCount: 1 };
			if (text === PRUNE_SQL) {
				deletes.push(values);
				const [content, authz, limit] = values as [Date | null, Date | null, number];
				const doomed = table
					.filter((r) =>
						r.category === 'authz'
							? authz != null && r.at < authz
							: content != null && r.at < content
					)
					.slice(0, limit);
				for (const r of doomed) table.splice(table.indexOf(r), 1);
				return { rows: [], rowCount: doomed.length };
			}
			return { rows: [], rowCount: 0 };
		},
		release: () => {}
	};
	return {
		pool: { connect: async () => client } as unknown as pg.Pool,
		deletes,
		statements
	};
}

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T00:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const CFG: AuditConfig = { retentionDays: 90, retentionDaysAuthz: 365, recordPrivateValues: false };

test('the prune keeps authz rows past the content window and removes them past the authz window', async () => {
	const table: Row[] = [
		{ id: 1, category: 'content', at: ago(100) },
		{ id: 2, category: 'authz', at: ago(100) },
		{ id: 3, category: 'authz', at: ago(400) },
		{ id: 4, category: 'data', at: ago(10) },
		{ id: 5, category: 'membership', at: ago(91) }
	];
	const p = prunePool(table);
	const r = await pruneAudit(p.pool, CFG, { now: NOW });
	assert.deepEqual(
		table.map((t) => t.id),
		[2, 4]
	);
	assert.equal(r.deleted, 3);
});

test('the batch bound holds: every DELETE carries the LIMIT and the loop stops on a short batch', async () => {
	const table: Row[] = Array.from({ length: 7 }, (_, i) => ({
		id: i,
		category: 'content',
		at: ago(200)
	}));
	const p = prunePool(table);
	const r = await pruneAudit(p.pool, CFG, { now: NOW, batch: 3 });
	assert.equal(r.deleted, 7);
	assert.equal(r.batches, 3);
	assert.ok(p.deletes.every((v) => v[2] === 3));
	assert.match(PRUNE_SQL, /LIMIT \$3/);
});

test('the batch loop has a ceiling of its own', async () => {
	const table: Row[] = Array.from({ length: 50 }, (_, i) => ({
		id: i,
		category: 'content',
		at: ago(200)
	}));
	const p = prunePool(table);
	const r = await pruneAudit(p.pool, CFG, { now: NOW, batch: 5, maxBatches: 2 });
	assert.equal(r.batches, 2);
	assert.equal(table.length, 40);
});

test('a replica that loses the advisory lock skips without deleting', async () => {
	const p = prunePool([{ id: 1, category: 'content', at: ago(200) }], { locked: true });
	const r = await pruneAudit(p.pool, CFG, { now: NOW });
	assert.equal(r.skipped, true);
	assert.equal(p.deletes.length, 0);
});

// ---------------------------------------------------------------------------
// Requirement 1: one table
// ---------------------------------------------------------------------------

test('audit_event keeps its rows when the group goes, and has no member foreign key', () => {
	const m = MIGRATIONS.find((x) => x.name === 'audit_event');
	assert.ok(m, 'no audit_event migration');
	const sql = m.sql.replace(/--.*$/gm, '');
	assert.match(sql, /group_id\s+uuid REFERENCES "group"\(id\) ON DELETE SET NULL/);
	assert.match(sql, /group_slug\s+text/);
	assert.doesNotMatch(sql, /CASCADE|REFERENCES member/);
	for (const col of [
		'actor_subject',
		'actor_email',
		'target_email',
		'target_subject',
		'target_id',
		'before',
		'after',
		'meta',
		'run_id'
	]) {
		assert.match(sql, new RegExp(`\\b${col}\\s`), `missing column ${col}`);
	}
});

// ---------------------------------------------------------------------------
// Requirement 9: run_id rows fold together
// ---------------------------------------------------------------------------

test('adjacent rows sharing a run_id fold into one block, in time order', () => {
	const rows = [
		{ id: 'a', runId: 'r1' },
		{ id: 'b', runId: 'r1' },
		{ id: 'c', runId: null },
		{ id: 'd', runId: null },
		{ id: 'e', runId: 'r2' }
	];
	assert.deepEqual(
		groupByRun(rows).map((b) => b.rows.map((r) => r.id)),
		[['a', 'b'], ['c'], ['d'], ['e']]
	);
});

// ---------------------------------------------------------------------------
// Requirement 3: the env split
// ---------------------------------------------------------------------------

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const importsOf = (code: string) =>
	[...code.matchAll(/^import[^;]*?from '([^']+)'/gms)].map((m) => m[1]);

test('audit-core and the scrubber import nothing from SvelteKit, so a script can write rows', () => {
	for (const file of ['./audit-core.ts', './redact.ts']) {
		const bad = importsOf(src(file)).filter((i) => i.startsWith('$'));
		assert.deepEqual(bad, [], `${file} pulls in ${bad.join(', ')}`);
	}
	assert.ok(importsOf(src('./audit.ts')).includes('$env/dynamic/private'), 'audit.ts binds $env');
	assert.ok(
		importsOf(src('../../../scripts/export-members.ts')).includes('../src/lib/server/audit-core'),
		'the CLI export writes its row through the env-free core'
	);
});

// ---------------------------------------------------------------------------
// Requirement 4: one rule set, two importers
// ---------------------------------------------------------------------------

test('the logger takes its redaction from redact.ts and no longer carries its own', () => {
	const code = src('./log.ts');
	assert.ok(importsOf(code).includes('./redact'));
	assert.doesNotMatch(code, /DENIED_KEYS|function digest|function redactValue/);
	assert.ok(importsOf(src('./audit-core.ts')).includes('./redact'));
});

// ---------------------------------------------------------------------------
// Requirement 7: in-process prune, with a compose escape hatch
// ---------------------------------------------------------------------------

test('both prune timers are unref’d and the interval follows the first run', async () => {
	let runs = 0;
	const h = schedulePrune(
		async () => {
			runs += 1;
		},
		{ firstMs: 1, everyMs: 60_000, random: () => 0 }
	);
	try {
		assert.equal(h.timers[0].hasRef(), false, 'the first-run timer holds the process open');
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(runs, 1);
		assert.equal(h.timers.length, 2);
		assert.equal(h.timers[1].hasRef(), false, 'the interval holds the process open');
	} finally {
		h.stop();
	}
});

test('the pruner starts beside ensureSchema, and the prune profile runs the same function', () => {
	const hooks = src('../../hooks.server.ts');
	assert.match(hooks, /void ensureSchema\(\)[^\n]*\n[\s\S]{0,400}?\nstartAuditPruner\(\);/);
	const compose = src('../../../docker-compose.yml');
	assert.match(compose, /\n  prune:\n    profiles:\n      - prune\n/);
	assert.match(compose, /command: \['pnpm', 'exec', 'tsx', 'scripts\/prune-audit\.ts'\]/);
	const script = src('../../../scripts/prune-audit.ts');
	assert.match(script, /pruneAudit\(pool, cfg\)/);
});

// ---------------------------------------------------------------------------
// Requirement 11: the erasure tension is stated, not resolved
// ---------------------------------------------------------------------------

test('docs/features.md names the retention-versus-erasure conflict as an open policy decision', () => {
	const readme = src('../../../docs/features.md');
	const at = readme.indexOf('### Retention versus erasure');
	assert.ok(at > 0, 'docs/features.md has no "Retention versus erasure" section');
	const section = readme.slice(at, readme.indexOf('\n## ', at));
	assert.match(section, /not cascade/i);
	assert.match(section, /policy decision/i);
	assert.match(section, /not (been )?made/i);
});

// ---------------------------------------------------------------------------
// Requirement 5: the boot-time warning
// ---------------------------------------------------------------------------

function bootLog() {
	const lines: { level: string; msg: string }[] = [];
	const at = (level: string) => (msg: string) => void lines.push({ level, msg });
	return { lines, log: { debug: at('debug'), info: at('info'), error: at('error') } };
}
const noSchedule = (() => ({ timers: [], stop() {} })) as unknown as typeof schedulePrune;
const NO_POOL = {} as pg.Pool;

test('recording private values is announced at error level on boot, and silent when off', () => {
	const on = bootLog();
	startPruner(NO_POOL, { AUDIT_RECORD_PRIVATE_VALUES: 'true' }, on.log, noSchedule);
	assert.deepEqual(on.lines, [{ level: 'error', msg: 'audit.private-values.ENABLED' }]);

	const off = bootLog();
	startPruner(NO_POOL, {}, off.log, noSchedule);
	assert.deepEqual(off.lines, []);
});

test('an unparseable retention setting starts no pruner and says so', () => {
	const b = bootLog();
	let scheduled = false;
	const r = startPruner(NO_POOL, { AUDIT_RETENTION_DAYS: 'ninety' }, b.log, (() => {
		scheduled = true;
		return { timers: [], stop() {} };
	}) as unknown as typeof schedulePrune);
	assert.equal(r, null);
	assert.equal(scheduled, false);
	assert.deepEqual(b.lines, [{ level: 'error', msg: 'audit.config-invalid' }]);
});

test('an unparseable retention setting does not silence the private-values warning', () => {
	const b = bootLog();
	startPruner(
		NO_POOL,
		{ AUDIT_RETENTION_DAYS: 'ninety', AUDIT_RECORD_PRIVATE_VALUES: 'true' },
		b.log,
		noSchedule
	);
	assert.deepEqual(
		b.lines.map((l) => l.msg),
		['audit.private-values.ENABLED', 'audit.config-invalid']
	);
});
