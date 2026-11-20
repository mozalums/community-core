import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import pg from 'pg';

// The SQL half of requests.test.ts, against a real Postgres: the fake there
// models the partial unique index and the row lock, this proves Postgres
// provides them. Needs a throwaway database:
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const pool = url ? new pg.Pool({ connectionString: url, max: 4 }) : null;

mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => pool,
		query: (text: string, values?: unknown[]) => pool!.query(text, values),
		withTransaction: async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
			const client = await pool!.connect();
			try {
				await client.query('BEGIN');
				const out = await fn(client);
				await client.query('COMMIT');
				return out;
			} catch (e) {
				await client.query('ROLLBACK');
				throw e;
			} finally {
				client.release();
			}
		}
	}
});
mock.module('$lib/server/members', { namedExports: { setSourceRow: async () => {} } });
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { submitRequest, approveRequest, denyRequest, requestData } = await import('./requests');
const { splitData } = await import('./field-schema');
const { migrate } = await import('./migrations');

const GROUP = {
	id: '',
	slug: 'f04-pg',
	name: 'F04',
	landingMd: null,
	status: 'active'
};
const EMAIL = 'nomi@example.org';
const WHO = { email: EMAIL, subject: `email:${EMAIL}` };
const ACTOR = { actorSubject: 'email:admin@example.com', actorEmail: 'admin@example.com' };
// A members-visible field and a private one, so approval has both bags to fill.
const data = () => requestData(EMAIL, { name: 'Nomi Vance', phone: '555 0100' }, {});

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, $2)
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[GROUP.slug, GROUP.name]
	);
	GROUP.id = rows[0].id;
});

beforeEach(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM access_request WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
});

after(async () => {
	await pool?.end();
});

const statuses = async () =>
	(
		await pool!.query<{ status: string; deny_reason: string | null }>(
			'SELECT status, deny_reason FROM access_request WHERE group_id = $1 ORDER BY created_at, id',
			[GROUP.id]
		)
	).rows.map((r) => [r.status, r.deny_reason]);

test('pg: migration 12 drops sheet_appended_at and refuses an unknown status', opts, async () => {
	const { rows } = await pool!.query(
		`SELECT column_name FROM information_schema.columns
		  WHERE table_name = 'access_request' ORDER BY column_name`
	);
	const cols = rows.map((r) => r.column_name);
	for (const c of ['data', 'decided_at', 'decided_by', 'deny_reason', 'updated_at']) {
		assert.ok(cols.includes(c), `no ${c}`);
	}
	assert.ok(!cols.includes('sheet_appended_at'));
	await assert.rejects(
		pool!.query(
			`INSERT INTO access_request (group_id, email, status) VALUES ($1, 'x@y.z', 'maybe')`,
			[GROUP.id]
		),
		/access_request_status_check/
	);
});

test('pg: resubmitting while pending leaves one row', opts, async () => {
	await submitRequest(GROUP, WHO, data(), 'Nomi Vance');
	const again = await submitRequest(GROUP, WHO, data(), 'Nomi Vance');
	assert.equal(again.resubmitted, true);
	assert.deepEqual(await statuses(), [['pending', null]]);
});

test('pg: resubmitting after a denial leaves two rows, both preserved', opts, async () => {
	const first = await submitRequest(GROUP, WHO, data(), 'Nomi Vance');
	await denyRequest(GROUP, first.id, ACTOR, 'not an alum');
	const second = await submitRequest(GROUP, WHO, data(), 'Nomi Vance');
	assert.equal(second.resubmitted, false);
	assert.deepEqual(await statuses(), [
		['denied', 'not an alum'],
		['pending', null]
	]);
});

test('pg: two concurrent approvals of one request make one member', opts, async () => {
	const { id } = await submitRequest(GROUP, WHO, data(), 'Nomi Vance');
	const results = await Promise.all([
		approveRequest(GROUP, id, ACTOR),
		approveRequest(GROUP, id, ACTOR)
	]);
	assert.equal(results.filter((r) => r === null).length, 1);
	const { rows } = await pool!.query('SELECT data, private_data FROM member WHERE group_id = $1', [
		GROUP.id
	]);
	assert.equal(rows.length, 1);
	const split = splitData(data());
	assert.deepEqual(split, { data: { name: 'Nomi Vance' }, privateData: { phone: '555 0100' } });
	assert.deepEqual(rows[0].data, split.data);
	assert.deepEqual(rows[0].private_data, split.privateData);
	const audits = await pool!.query(
		`SELECT count(*)::int AS n FROM audit_event WHERE action = 'request.approved' AND target_id = $1`,
		[id]
	);
	assert.equal(audits.rows[0].n, 1);
});
