import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { auditIn, pruneAudit, type AuditConfig } from './audit-core';
import { migrate } from './migrations';

// The SQL half of audit-core.test.ts, against a real Postgres: the stubs there
// prove which statements are sent, this proves what Postgres does with them.
// Needs a throwaway database it may drop tables in, so it runs only when one is
// named:
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

let pool: pg.Pool;

before(async () => {
	if (!url) return;
	pool = new pg.Pool({ connectionString: url, max: 3 });
	await migrate(pool);
});

after(async () => {
	await pool?.end();
});

async function rows(where = 'true'): Promise<{ action: string; category: string }[]> {
	return (await pool.query(`SELECT action, category FROM audit_event WHERE ${where} ORDER BY id`))
		.rows;
}

async function inTx(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await fn(client);
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
}

test('pg: a rolled-back transaction leaves no audit row', opts, async () => {
	await pool.query('DELETE FROM audit_event');
	await assert.rejects(() =>
		inTx(async (client) => {
			await auditIn(client, { category: 'data', action: 'pg.rollback' });
			throw new Error('the update failed');
		})
	);
	assert.deepEqual(await rows(), []);

	await inTx((client) => auditIn(client, { category: 'data', action: 'pg.commit' }));
	assert.deepEqual(
		(await rows()).map((r) => r.action),
		['pg.commit']
	);
});

test('pg: deleting the group keeps its audit rows, with the slug', opts, async () => {
	const g = await pool.query<{ id: string }>(
		`INSERT INTO "group"(slug, name) VALUES ('audit-pg-test', 'x') RETURNING id`
	);
	await auditIn(pool, {
		category: 'authz',
		action: 'pg.group-delete',
		groupId: g.rows[0].id,
		groupSlug: 'audit-pg-test'
	});
	await pool.query(`DELETE FROM "group" WHERE id = $1`, [g.rows[0].id]);
	const r = await pool.query(
		`SELECT group_id, group_slug FROM audit_event WHERE action = 'pg.group-delete'`
	);
	assert.deepEqual(r.rows, [{ group_id: null, group_slug: 'audit-pg-test' }]);
});

const CFG: AuditConfig = { retentionDays: 90, retentionDaysAuthz: 365, recordPrivateValues: false };

async function seed(category: string, daysAgo: number, n = 1) {
	await pool.query(
		`INSERT INTO audit_event(category, action, at)
		 SELECT $1, 'pg.prune', now() - make_interval(days => $2::int) FROM generate_series(1, $3)`,
		[category, daysAgo, n]
	);
}

test(
	'pg: the prune keeps authz past the content window and removes it past its own',
	opts,
	async () => {
		await pool.query('DELETE FROM audit_event');
		await seed('content', 100);
		await seed('authz', 100);
		await seed('authz', 400);
		await seed('membership', 10);
		const r = await pruneAudit(pool, CFG);
		assert.equal(r.deleted, 2);
		assert.deepEqual(
			(await rows()).map((x) => x.category),
			['authz', 'membership']
		);
		assert.equal(
			(await pool.query(`SELECT 1 FROM audit_event WHERE category = 'authz'`)).rowCount,
			1
		);
	}
);

test('pg: 0 keeps forever', opts, async () => {
	await pool.query('DELETE FROM audit_event');
	await seed('content', 5000);
	await seed('authz', 5000);
	const r = await pruneAudit(pool, { ...CFG, retentionDays: 0, retentionDaysAuthz: 0 });
	assert.equal(r.deleted, 0);
	assert.equal((await rows()).length, 2);
});

test('pg: the batch bound holds against the real statement', opts, async () => {
	await pool.query('DELETE FROM audit_event');
	await seed('data', 200, 25);
	const r = await pruneAudit(pool, CFG, { batch: 10 });
	assert.equal(r.deleted, 25);
	assert.equal(r.batches, 3);
});

test('pg: a second pruner skips while the first holds the lock', opts, async () => {
	const holder = await pool.connect();
	try {
		await holder.query('SELECT pg_advisory_lock(4607002)');
		const r = await pruneAudit(pool, CFG);
		assert.equal(r.skipped, true);
	} finally {
		await holder.query('SELECT pg_advisory_unlock(4607002)');
		holder.release();
	}
});
