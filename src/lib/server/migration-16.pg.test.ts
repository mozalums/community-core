import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { MIGRATIONS, WRITER_CUTOVER_VERSIONS } from './migrations';

// Migration 16 against real Postgres, applied to a database at version 15. Each
// case builds that database in a schema of its own inside one transaction and
// rolls it back.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
after(async () => {
	await pool?.end();
});

const m16 = MIGRATIONS.find((m) => m.version === 16)!;

async function atVersion15<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
	const c = await pool!.connect();
	const schema = `m16_${randomBytes(4).toString('hex')}`;
	try {
		await c.query('BEGIN');
		await c.query('SELECT pg_advisory_xact_lock(4607001)');
		await c.query(`CREATE SCHEMA ${schema}`);
		await c.query(`SET LOCAL search_path TO ${schema}, public`);
		for (const m of MIGRATIONS.filter((x) => x.version <= 15)) await c.query(m.sql);
		await c.query(`INSERT INTO "group" (slug, name) VALUES ('a', 'A'), ('b', 'B')`);
		return await fn(c);
	} finally {
		await c.query('ROLLBACK');
		c.release();
	}
}

async function groupColumns(c: pg.PoolClient): Promise<string[]> {
	const { rows } = await c.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = current_schema() AND table_name = 'group'`
	);
	return rows.map((r) => r.column_name);
}

test('E41 R4: migration 16 drops both document columns, gated like the other column drops', () => {
	assert.equal(m16.name, 'drop_group_documents');
	assert.match(
		m16.sql,
		/DROP COLUMN IF EXISTS manifesto_md,\s*DROP COLUMN IF EXISTS code_of_conduct_md;/
	);
	// The check runs first, in the same transaction, so a refusal drops nothing.
	assert.ok(m16.sql.indexOf('RAISE EXCEPTION') < m16.sql.indexOf('DROP COLUMN'));
	assert.ok(WRITER_CUTOVER_VERSIONS.has(16), 'an older instance selects these columns by name');
});

test(
	'pg: E41 R4: migration 16 drops the columns when every group has both empty',
	opts,
	async () => {
		await atVersion15(async (c) => {
			// NULL, an empty string and whitespace are all empty.
			await c.query(
				`UPDATE "group" SET manifesto_md = '', code_of_conduct_md = '  ' WHERE slug = 'a'`
			);
			await c.query(m16.sql);
			const cols = await groupColumns(c);
			assert.ok(!cols.includes('manifesto_md'));
			assert.ok(!cols.includes('code_of_conduct_md'));
			assert.ok(cols.includes('landing_md'), 'the migration dropped more than the two documents');
		});
	}
);

for (const column of ['manifesto_md', 'code_of_conduct_md']) {
	test(
		`pg: E41 R4: migration 16 aborts, naming the group, while ${column} holds text`,
		opts,
		async () => {
			await atVersion15(async (c) => {
				await c.query(`UPDATE "group" SET ${column} = '# Ours' WHERE slug = 'b'`);
				await c.query('SAVEPOINT before_m16');
				await assert.rejects(
					c.query(m16.sql),
					/migration 16: .*holds text for b;.*Nothing was applied/
				);
				await c.query('ROLLBACK TO SAVEPOINT before_m16');
				const cols = await groupColumns(c);
				assert.ok(cols.includes('manifesto_md') && cols.includes('code_of_conduct_md'));
			});
		}
	);
}
