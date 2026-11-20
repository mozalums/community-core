import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, mock, test } from 'node:test';
import pg from 'pg';

// Migration 15 against real Postgres, applied to a database at version 14 that
// still holds what the sheet era stored. Each case builds that database in a
// schema of its own inside one transaction and rolls it back.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
after(async () => {
	await pool?.end();
});

// The readers below go through the app's own query(), pointed at whichever
// transaction the running case holds.
let current: pg.PoolClient | null = null;
mock.module('$lib/server/postgres', {
	namedExports: {
		query: (text: string, values?: unknown[]) => current!.query(text, values),
		withTransaction: <T>(fn: (c: pg.PoolClient) => Promise<T>) => fn(current!)
	}
});
mock.module('$lib/server/admin', { namedExports: { isAdmin: () => false } });
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { MIGRATIONS } = await import('./migrations');
const { getGroupBySlug, getGroupById } = await import('./groups');
const { getMemberById, resolveMember } = await import('./members');
const m15 = MIGRATIONS.find((m) => m.version === 15)!;

async function inSchema<T>(upTo: number, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
	const c = await pool!.connect();
	const schema = `m15_${randomBytes(4).toString('hex')}`;
	try {
		await c.query('BEGIN');
		// The engine's own lock key: other suites run migrate() concurrently, and
		// migration 1's CREATE EXTENSION races theirs without it.
		await c.query('SELECT pg_advisory_xact_lock(4607001)');
		await c.query(`CREATE SCHEMA ${schema}`);
		await c.query(`SET LOCAL search_path TO ${schema}, public`);
		for (const m of MIGRATIONS.filter((x) => x.version <= upTo)) await c.query(m.sql);
		current = c;
		return await fn(c);
	} finally {
		current = null;
		await c.query('ROLLBACK');
		c.release();
	}
}

async function columns(c: pg.PoolClient, table: string): Promise<string[]> {
	const { rows } = await c.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = current_schema() AND table_name = $1 ORDER BY 1`,
		[table]
	);
	return rows.map((r) => r.column_name);
}

const SHEET_GROUP = ['sheet_id', 'sheet_range', 'column_map'];
const SHEET_MEMBER = ['source_row', 'synced_at', 'visibility'];

// A group and two members the way the last sync left them, with a row in every
// table that hangs off either.
async function sheetEra(c: pg.PoolClient): Promise<{ groupId: string; memberId: string }> {
	const g = await c.query<{ id: string }>(
		`INSERT INTO "group" (slug, name, sheet_id, sheet_range, column_map, landing_md)
		 VALUES ('m15', 'M15', '1AbCdEf', 'Members!A:Z', '{"email":"Email"}', '# hi') RETURNING id`
	);
	const groupId = g.rows[0].id;
	const m = await c.query<{ id: string }>(
		`INSERT INTO member (group_id, email, ident_subject, name, city, linkedin, data,
		                     private_data, status, source_row, synced_at, visibility)
		 VALUES ($1, 'ada@example.org', 'oidc:ada', 'Ada Byron', 'London', 'https://l.example/ada',
		         '{"firstName":"Ada","lastName":"Byron"}', '{"postal":"12 St James Square"}',
		         'active', 7, now(), '{"city":"members"}'),
		        ($1, 'gone@example.org', NULL, 'Gone', NULL, NULL, '{}', '{}', 'removed', NULL, NULL, '{}')
		 RETURNING id`,
		[groupId]
	);
	await c.query(`INSERT INTO sync_run (group_id, status) VALUES ($1, 'ok'), ($1, 'running')`, [
		groupId
	]);
	await c.query(
		`INSERT INTO group_admin (group_id, ident_subject, email)
		 VALUES ($1, 'email:ada@example.org', 'ada@example.org')`,
		[groupId]
	);
	await c.query(
		`INSERT INTO access_request (group_id, email, name, data)
		 VALUES ($1, 'nomi@example.org', 'Nomi', '{"firstName":"Nomi"}')`,
		[groupId]
	);
	return { groupId, memberId: m.rows[0].id };
}

// Every surviving column of every surviving row, as one comparable value.
async function survivors(c: pg.PoolClient): Promise<string> {
	const { rows } = await c.query<{ snap: string }>(
		`SELECT jsonb_build_object(
		   'group',   (SELECT jsonb_agg(to_jsonb(g) - $1::text[] ORDER BY g.slug) FROM "group" g),
		   'member',  (SELECT jsonb_agg(to_jsonb(m) - $2::text[] ORDER BY m.email) FROM member m),
		   'admin',   (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.ident_subject) FROM group_admin a),
		   'request', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.email) FROM access_request r)
		 )::text AS snap`,
		[SHEET_GROUP, SHEET_MEMBER]
	);
	return rows[0].snap;
}

test(
	'pg: migration 15 drops the six columns and sync_run and changes nothing else',
	opts,
	async () => {
		await inSchema(14, async (c) => {
			await sheetEra(c);
			const before = await survivors(c);
			const groupCols = await columns(c, 'group');
			const memberCols = await columns(c, 'member');
			for (const col of SHEET_GROUP) assert.ok(groupCols.includes(col), `fixture lacks ${col}`);
			for (const col of SHEET_MEMBER) assert.ok(memberCols.includes(col), `fixture lacks ${col}`);

			await c.query(m15.sql);

			assert.deepEqual(
				await columns(c, 'group'),
				groupCols.filter((x) => !SHEET_GROUP.includes(x))
			);
			assert.deepEqual(
				await columns(c, 'member'),
				memberCols.filter((x) => !SHEET_MEMBER.includes(x))
			);
			const { rows } = await c.query(`SELECT to_regclass('sync_run') AS t`);
			assert.equal(rows[0].t, null, 'sync_run survived');
			assert.equal(await survivors(c), before, 'a surviving row or column changed');
		});
	}
);

test(
	'pg: migration 15 applies twice, and to a database that never held a sheet row',
	opts,
	async () => {
		await inSchema(14, async (c) => {
			await c.query(m15.sql);
			await c.query(m15.sql);
			assert.ok(!(await columns(c, 'member')).includes('source_row'));
		});
	}
);

test('pg: a database built from nothing ends with no sheet-era column or table', opts, async () => {
	await inSchema(15, async (c) => {
		const all = [...(await columns(c, 'group')), ...(await columns(c, 'member'))];
		for (const col of [...SHEET_GROUP, ...SHEET_MEMBER]) {
			assert.ok(!all.includes(col), `${col} exists after every migration`);
		}
		const { rows } = await c.query(`SELECT to_regclass('sync_run') AS t`);
		assert.equal(rows[0].t, null);
	});
});

test(
	'pg: the group and member readers and full-text search run against the migrated schema',
	opts,
	async () => {
		await inSchema(14, async (c) => {
			const { groupId, memberId } = await sheetEra(c);
			await c.query(m15.sql);

			const group = await getGroupBySlug('m15');
			assert.equal(group?.id, groupId);
			assert.equal(group?.landingMd, '# hi');
			assert.deepEqual(Object.keys(group!).sort(), ['id', 'landingMd', 'name', 'slug', 'status']);
			assert.equal((await getGroupById(groupId))?.slug, 'm15');

			const member = await getMemberById(groupId, memberId);
			assert.equal(member?.name, 'Ada Byron');
			assert.equal(member?.data.firstName, 'Ada');
			assert.equal(member?.privateData.postal, '12 St James Square');
			assert.equal(
				(await resolveMember(groupId, 'ada@example.org', 'oidc:ada')).member?.id,
				memberId
			);

			const found = await c.query(
				`SELECT count(*)::int AS n FROM member
			  WHERE group_id = $1 AND search_tsv @@ plainto_tsquery('simple', 'Byron')`,
				[groupId]
			);
			assert.equal(found.rows[0].n, 1, 'the generated search column broke');
		});
	}
);
