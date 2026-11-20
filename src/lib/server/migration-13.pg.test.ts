import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { MIGRATIONS, migrate, writerCutoverRefusal } from './migrations';

// Migration 13 against real Postgres, and the runner guard that stops it
// applying under a live app. Each case builds its database in a schema or a
// database of its own, so nothing here touches the tables the other pg suites
// use.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
after(async () => {
	await pool?.end();
});

const m13 = MIGRATIONS.find((m) => m.version === 13)!;

async function atVersion12<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
	const c = await pool!.connect();
	const schema = `m13_${randomBytes(4).toString('hex')}`;
	try {
		await c.query('BEGIN');
		// The engine's own lock key: other suites run migrate() concurrently, and
		// migration 1's CREATE EXTENSION races theirs without it.
		await c.query('SELECT pg_advisory_xact_lock(4607001)');
		await c.query(`CREATE SCHEMA ${schema}`);
		await c.query(`SET LOCAL search_path TO ${schema}, public`);
		for (const m of MIGRATIONS.filter((x) => x.version <= 12)) await c.query(m.sql);
		return await fn(c);
	} finally {
		await c.query('ROLLBACK');
		c.release();
	}
}

// A database built migration by migration up to 12 in a database of its own,
// so the real runner, its advisory lock and its single transaction decide what
// happens to 13, and the ledger it leaves is the one an operator would see.
async function at12(dbUrl: URL, rows: { member?: object; request?: object }) {
	const c = new pg.Client({ connectionString: dbUrl.toString() });
	await c.connect();
	try {
		await ledgerAt(c, 12);
		for (const m of MIGRATIONS.filter((x) => x.version <= 12)) await c.query(m.sql);
		const g = await c.query<{ id: string }>(
			`INSERT INTO "group" (slug, name) VALUES ('m13', 'M13') RETURNING id`
		);
		if (rows.member) {
			await c.query(
				`INSERT INTO member (group_id, email, name, data) VALUES ($1, 'ada@example.org', 'Ada Byron', $2)`,
				[g.rows[0].id, JSON.stringify(rows.member)]
			);
		}
		if (rows.request) {
			await c.query(
				`INSERT INTO access_request (group_id, email, name, data) VALUES ($1, 'nomi@example.org', 'Nomi', $2)`,
				[g.rows[0].id, JSON.stringify(rows.request)]
			);
		}
	} finally {
		await c.end();
	}
}

async function migrateAt(dbUrl: URL) {
	const p = new pg.Pool({ connectionString: dbUrl.toString(), max: 1 });
	try {
		return await migrate(p);
	} finally {
		await p.end();
	}
}

async function stateOf(dbUrl: URL) {
	const c = new pg.Client({ connectionString: dbUrl.toString() });
	await c.connect();
	try {
		const ledger = (await c.query<{ v: number }>('SELECT max(version) AS v FROM schema_migrations'))
			.rows[0].v;
		const privateData = (
			await c.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM information_schema.columns
				  WHERE table_name = 'member' AND column_name = 'private_data'`
			)
		).rows[0].n;
		const members = (await c.query<{ data: object }>('SELECT data FROM member')).rows;
		const requests = (await c.query<{ data: object }>('SELECT data FROM access_request')).rows;
		return { ledger, privateData, members, requests };
	} finally {
		await c.end();
	}
}

// Header text as the retired Sheet spelled it. The table that converted these
// is no longer in core, so this build has to refuse them rather than guess.
const SHEET_KEYED = {
	'First Name': 'Ada',
	Bio: 'Wrote the first program.',
	'Postal Address': '12 Secretstrasse'
};

test('E41 R7: a fresh database applies migration 13 and every later one, holding no data', opts, async () => {
	await withPrivateDatabase(async (dbUrl) => {
		const applied = await migrateAt(dbUrl);
		const latest = Math.max(...MIGRATIONS.map((m) => m.version));
		assert.deepEqual(
			applied,
			MIGRATIONS.map((m) => m.version).sort((a, b) => a - b)
		);
		const s = await stateOf(dbUrl);
		assert.equal(s.ledger, latest);
		assert.equal(s.privateData, 1, 'readers need member.private_data from migration 13');
		assert.deepEqual([s.members, s.requests], [[], []]);
	});
});

test('E41 R7: a database at 12 with no member data records 13 and changes no row', opts, async () => {
	await withPrivateDatabase(async (dbUrl) => {
		await at12(dbUrl, { member: {}, request: {} });
		const applied = await migrateAt(dbUrl);
		assert.equal(applied[0], 13);
		const s = await stateOf(dbUrl);
		assert.equal(s.privateData, 1);
		assert.deepEqual(s.members, [{ data: {} }]);
		assert.deepEqual(s.requests, [{ data: {} }]);
	});
});

for (const [what, rows] of [
	['member rows', { member: SHEET_KEYED }],
	['membership requests', { request: SHEET_KEYED }]
] as const) {
	test(`E41 R7: ${what} keyed by Sheet headers refuse migration 13 before any write`, opts, async () => {
		await withPrivateDatabase(async (dbUrl) => {
			await at12(dbUrl, rows);
			await assert.rejects(migrateAt(dbUrl), (e: Error) => {
				assert.match(e.message, /^migration 13: /);
				assert.match(e.message, /retired Google Sheet headers/);
				assert.match(e.message, /Migrate this database first with a build from before/);
				assert.match(e.message, /Nothing was changed/);
				return true;
			});
			const s = await stateOf(dbUrl);
			assert.equal(s.ledger, 12, 'the ledger moved past 12');
			assert.equal(s.privateData, 0, 'migration 13 altered member before refusing');
			assert.deepEqual(
				[...s.members, ...s.requests].map((r) => r.data),
				[SHEET_KEYED]
			);
		});
	});
}

test('R3: a private value is out of full-text search; a shared one is in', opts, async () => {
	await atVersion12(async (c) => {
		await c.query(m13.sql);
		const g = await c.query<{ id: string }>(
			`INSERT INTO "group" (slug, name) VALUES ('m13', 'M13') RETURNING id`
		);
		const m = await c.query<{ id: string }>(
			`INSERT INTO member (group_id, email, name, data, private_data)
			 VALUES ($1, 'ada@example.org', 'Ada Byron', $2, $3) RETURNING id`,
			[
				g.rows[0].id,
				JSON.stringify({ handle: 'enchantress', fellow: 'TRUE' }),
				JSON.stringify({ postal: '12 Secretstrasse' })
			]
		);
		const hit = async (word: string) =>
			(
				await c.query(
					`SELECT search_tsv @@ to_tsquery('simple', $2) AS hit FROM member WHERE id = $1`,
					[m.rows[0].id, word]
				)
			).rows[0].hit;
		assert.equal(await hit('enchantress'), true, 'a shared field is not searchable');
		assert.equal(await hit('secretstrasse'), false, 'the postal address reached search');
		assert.equal(await hit('true'), false, 'a checkbox value reached search');
		const def = await c.query(
			`SELECT pg_get_functiondef('member_search_values(jsonb)'::regprocedure) AS def,
			        provolatile FROM pg_proc WHERE proname = 'member_search_values'`
		);
		assert.doesNotMatch(def.rows[0].def, /postal|whatsapp|\bkey\b/);
		assert.equal(def.rows[0].provolatile, 'i', 'member_search_values is not IMMUTABLE');
	});
});

// ---------------------------------------------------------------------------
// R7: the gating runner refuses migration 13 while a writer may be live
// ---------------------------------------------------------------------------

async function ledgerAt(c: pg.ClientBase, top: number) {
	await c.query(`CREATE TABLE schema_migrations (version int PRIMARY KEY, name text NOT NULL)`);
	await c.query(
		`INSERT INTO schema_migrations SELECT v, 'm' || v FROM generate_series(1, $1) v`,
		[top]
	);
}

async function inOwnSchema<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
	const c = await pool!.connect();
	try {
		await c.query('BEGIN');
		const schema = `m13g_${randomBytes(4).toString('hex')}`;
		await c.query(`CREATE SCHEMA ${schema}`);
		await c.query(`SET LOCAL search_path TO ${schema}`);
		return await fn(c);
	} finally {
		await c.query('ROLLBACK');
		c.release();
	}
}

test('R7: a database with no ledger has never served an app, so nothing is refused', opts, async () => {
	await inOwnSchema(async (c) => assert.equal(await writerCutoverRefusal(c, undefined), null));
});

test('R7: migration 13 pending and no stopped-writers statement is refused', opts, async () => {
	await inOwnSchema(async (c) => {
		await ledgerAt(c, 12);
		const { rows } = await c.query<{ db: string }>('SELECT current_database() AS db');
		for (const ack of [undefined, '', 'some_other_db']) {
			const r = await writerCutoverRefusal(c, ack);
			assert.match(r ?? '', new RegExp(`LOREM_WRITERS_STOPPED=${rows[0].db}\\b`));
			assert.match(r ?? '', /Nothing was applied/);
		}
	});
});

test('R7: with every cutover migration applied no statement is needed', opts, async () => {
	await inOwnSchema(async (c) => {
		await ledgerAt(c, Math.max(...MIGRATIONS.map((m) => m.version)));
		assert.equal(await writerCutoverRefusal(c, undefined), null);
	});
});

// 13 applied is not the end of it: 15 and 16 drop columns the running app selects.
test('E12 R6: a ledger at 13 or 14 is refused for the later column drops alone', opts, async () => {
	for (const top of [13, 14]) {
		await inOwnSchema(async (c) => {
			await ledgerAt(c, top);
			const r = (await writerCutoverRefusal(c, undefined)) ?? '';
			assert.match(r, /^migration 15, 16 /, `ledger at ${top}`);
			assert.match(r, /LOREM_WRITERS_STOPPED=/);
			assert.match(r, /Nothing was applied/);
		});
	}
});

test('E12 R6: a ledger at 12 is refused for every cutover in one stop', opts, async () => {
	await inOwnSchema(async (c) => {
		await ledgerAt(c, 12);
		assert.match((await writerCutoverRefusal(c, undefined)) ?? '', /^migration 13, 15, 16 /);
	});
});

test('R7: the statement is not believed while another client holds a connection', opts, async () => {
	const other = await pool!.connect();
	try {
		await other.query('SELECT 1');
		await inOwnSchema(async (c) => {
			await ledgerAt(c, 12);
			const { rows } = await c.query<{ db: string }>('SELECT current_database() AS db');
			assert.match(
				(await writerCutoverRefusal(c, rows[0].db)) ?? '',
				/other connection\(s\) to .* are open/
			);
		});
	} finally {
		other.release();
	}
});

// A database of its own, because pg_stat_activity is per database and the
// other suites hold connections to the shared one while this runs.
async function withPrivateDatabase<T>(fn: (dbUrl: URL) => Promise<T>): Promise<T> {
	const name = `m13g_${randomBytes(4).toString('hex')}`;
	await pool!.query(`CREATE DATABASE ${name}`);
	const dbUrl = new URL(url!);
	dbUrl.pathname = `/${name}`;
	try {
		return await fn(dbUrl);
	} finally {
		await pool!.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
	}
}

test('R7: with the writers stopped and named, the guard lets the runner through', opts, async () => {
	await withPrivateDatabase(async (dbUrl) => {
		const c = new pg.Client({ connectionString: dbUrl.toString() });
		await c.connect();
		try {
			await ledgerAt(c, 12);
			assert.equal(await writerCutoverRefusal(c, dbUrl.pathname.slice(1)), null);
		} finally {
			await c.end();
		}
	});
});

async function runnerRefusesAt(top: number, script = 'scripts/migrate.ts') {
	await withPrivateDatabase(async (dbUrl) => {
		const c = new pg.Client({ connectionString: dbUrl.toString() });
		await c.connect();
		try {
			await ledgerAt(c, top);
		} finally {
			await c.end();
		}
		const env = {
			PATH: process.env.PATH,
			POSTGRES_HOST: dbUrl.hostname,
			POSTGRES_PORT: dbUrl.port || '5432',
			POSTGRES_DATABASE: dbUrl.pathname.slice(1),
			POSTGRES_USER: decodeURIComponent(dbUrl.username),
			POSTGRES_PASSWORD: decodeURIComponent(dbUrl.password),
			POSTGRES_SSL: 'false'
		};
		const run = promisify(execFile);
		await assert.rejects(
			run(process.execPath, ['--import', 'tsx', script], { env }),
			(e: { code: number; stderr: string }) =>
				e.code === 1 && /LOREM_WRITERS_STOPPED=/.test(e.stderr)
		);
		const after = new pg.Client({ connectionString: dbUrl.toString() });
		await after.connect();
		try {
			const { rows } = await after.query('SELECT max(version) AS v FROM schema_migrations');
			assert.equal(rows[0].v, top);
		} finally {
			await after.end();
		}
	});
}

test('R7: scripts/migrate.ts refuses a pending migration 13 and applies nothing', opts, () =>
	runnerRefusesAt(12)
);

test('E12 R6: scripts/migrate.ts refuses a pending migration 15 and applies nothing', opts, () =>
	runnerRefusesAt(14)
);

// `deploy/run.sh seed` reaches a host whose checkout a refused deploy already
// moved forward, with the old app still serving.
test('E12 R6: scripts/seed.ts refuses a pending migration 15 and applies nothing', opts, () =>
	runnerRefusesAt(14, 'scripts/seed.ts')
);
