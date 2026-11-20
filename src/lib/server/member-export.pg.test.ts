import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { parseCsv } from './csv-core';
import { loadExportMembers, memberCsv, readMemberCsv } from './member-export';
import { migrate } from './migrations';

// scripts/export-members.ts end to end against a real schema: the SQL, the
// transaction, the audit row and the bytes on disk.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 4 }) : null;

const SLUG = 'export-test';
let groupId = '';

function runScript(args: string[]) {
	const u = new URL(url!);
	return spawnSync(
		process.execPath,
		[
			'--import',
			'tsx',
			new URL('../../../scripts/export-members.ts', import.meta.url).pathname,
			...args
		],
		{
			encoding: 'utf8',
			timeout: 60_000,
			env: {
				...process.env,
				POSTGRES_HOST: u.hostname,
				POSTGRES_PORT: u.port || '5432',
				POSTGRES_DATABASE: u.pathname.slice(1),
				POSTGRES_USER: decodeURIComponent(u.username),
				POSTGRES_PASSWORD: decodeURIComponent(u.password),
				POSTGRES_SSL: 'false'
			}
		}
	);
}

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, 'Export test')
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[SLUG]
	);
	groupId = rows[0].id;
	await pool.query('DELETE FROM member WHERE group_id = $1', [groupId]);
	// A string goes in as JSON text unchanged, so a number JavaScript cannot
	// hold reaches the database as written.
	const json = (v: object | string) => (typeof v === 'string' ? v : JSON.stringify(v));
	const insert = (email: string, status: string, data: object | string, priv: object | string) =>
		pool!.query(
			`INSERT INTO member (group_id, email, name, data, private_data, status)
			 VALUES ($1, $2, 'n', $3::jsonb, $4::jsonb, $5)`,
			[groupId, email, json(data), json(priv), status]
		);
	await insert(
		'zoe@example.com',
		'active',
		{ name: 'Zoë', bio: 'One, "two"\nthree\r\n=four', country: 'TRUE' },
		{ phone: '-7700', 'x.Postal': "'Flat 1\n2 Road", 'x.Team': '@ops' }
	);
	// The headers Status and x.Status as migration 13 preserves them, and JSON
	// values that are not strings, which it moves unchanged.
	// Numbers past a double's precision and range, a scale a double drops, and
	// the same digits as a string, top level and nested.
	await insert(
		'ada@example.com',
		'active',
		'{"name":"Ada","bio":["a,b","c"],"x.Seq":9007199254740993}',
		`{"x.Status":"one","x.x.Status":"two",
		  "x.Years active":{"from":2004,"to":null},
		  "x.Counts":{"big":9007199254740993,"huge":1e400,"scale":1.10,
		              "list":[9007199254740992,9007199254740993,"9007199254740993",-1e-400]}}`
	);
	// A removed member, with an x.* key in each bag and an object beside the
	// address. A stored Email field is the every-role field set's to carry:
	// src/lib/skin/every-role/export.pg.test.ts.
	await insert(
		'gone@example.com',
		'removed',
		{ name: 'Gone', 'x.Full Name': 'Gone P' },
		{ 'x.Previous': { previous: 'old@example.com' }, 'x.Login Address': 'gone@example.com' }
	);
});

after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [groupId]);
	await pool.query(`DELETE FROM audit_event WHERE group_id = $1`, [groupId]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [groupId]);
	await pool.end();
});

test(
	'R8: the script writes the full export, audited, and it reads back to the database',
	opts,
	async () => {
		const out = join(mkdtempSync(join(tmpdir(), 'f06-')), 'roster.csv');
		const r = runScript([SLUG, '--private', '--removed', '--out', out]);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(statSync(out).mode & 0o777, 0o600);

		const full = { includePrivate: true, includeRemoved: true };
		const stored = await loadExportMembers(pool!, groupId, full);
		const bytes = readFileSync(out, 'utf8');
		assert.equal(bytes, memberCsv(stored, full), 'the script and the endpoint write the same file');

		// R9 against real rows: every stored value comes back under its key, and
		// the sign-in address beside it, read from the file and the schema alone.
		// PostgreSQL is the oracle, not this driver: the decoded values go back in
		// as JSON text and are compared with the stored bags as jsonb text there,
		// so a number rounded anywhere on the way out cannot match.
		const back = readMemberCsv(bytes);
		assert.equal(back.length, 3);
		for (const m of back) {
			const { rows } = await pool!.query<{ status: string; stored: string; decoded: string }>(
				`SELECT status, (data || private_data)::text AS stored, $3::jsonb::text AS decoded
				   FROM member WHERE group_id = $1 AND email = $2`,
				[groupId, m.email, JSON.stringify(m.values)]
			);
			assert.equal(rows.length, 1, `${m.email} is not a stored member`);
			assert.equal(m.status, rows[0].status);
			assert.equal(rows[0].decoded, rows[0].stored, `${m.email} does not decode to what is stored`);
		}
		const { rows: counts } = await pool!.query<{ v: string }>(
			`SELECT (private_data->'x.Counts')::text AS v FROM member WHERE email = 'ada@example.com'`
		);
		assert.match(counts[0].v, /"big": 9007199254740993\b/, 'the seed itself was rounded');

		const audit = await pool!.query(
			`SELECT action, actor_subject, meta FROM audit_event WHERE group_id = $1`,
			[groupId]
		);
		assert.deepEqual(audit.rows, [
			{
				action: 'members.export-private',
				actor_subject: 'cli:export-members',
				meta: { privateFields: true, includeRemoved: true, rows: 3 }
			}
		]);

		// A second run onto the same path refuses rather than overwriting.
		assert.equal(runScript([SLUG, '--out', out]).status, 1);
	}
);

test(
	'R3: the default script export is active members with nothing private and no audit row',
	opts,
	async () => {
		await pool!.query(`DELETE FROM audit_event WHERE group_id = $1`, [groupId]);
		const r = runScript([SLUG]);
		assert.equal(r.status, 0, r.stderr);
		const rows = parseCsv(r.stdout);
		assert.deepEqual(
			rows.slice(1).map((c) => c[rows[0].indexOf('Email')]),
			['ada@example.com', 'zoe@example.com']
		);
		assert.doesNotMatch(r.stdout, /Flat 1|7700|@ops/);
		const audit = await pool!.query(`SELECT 1 FROM audit_event WHERE group_id = $1`, [groupId]);
		assert.equal(audit.rowCount, 0);
	}
);
