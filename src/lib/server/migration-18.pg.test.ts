import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { MIGRATIONS } from './migrations';

// Migration 18 against real Postgres, every migration applied in a schema of
// its own inside one transaction that rolls back.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
after(async () => {
	await pool?.end();
});

test(
	'pg: F8 R1/R4: deleting a member removes their passkeys, and an email change touches none',
	opts,
	async () => {
		const c = await pool!.connect();
		const schema = `m18_${randomBytes(4).toString('hex')}`;
		try {
			await c.query('BEGIN');
			await c.query('SELECT pg_advisory_xact_lock(4607001)');
			await c.query(`CREATE SCHEMA ${schema}`);
			await c.query(`SET LOCAL search_path TO ${schema}, public`);
			for (const m of MIGRATIONS) await c.query(m.sql);
			const {
				rows: [g]
			} = await c.query(`INSERT INTO "group" (slug, name) VALUES ('a', 'A') RETURNING id`);
			const {
				rows: [m]
			} = await c.query(
				`INSERT INTO member (group_id, email) VALUES ($1, 'a@example.org') RETURNING id`,
				[g.id]
			);
			await c.query(
				`INSERT INTO passkey_credential (id, member_id, public_key, device_type, nickname)
			 VALUES ('\\x01', $1, '\\x02', 'singleDevice', 'Laptop'),
			        ('\\x03', $1, '\\x04', 'multiDevice', 'Phone')`,
				[m.id]
			);

			await c.query(`UPDATE member SET email = 'b@example.org' WHERE id = $1`, [m.id]);
			const kept = await c.query(
				'SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = $1',
				[m.id]
			);
			assert.equal(kept.rows[0].n, 2, 'an email change lost passkeys');

			await c.query('DELETE FROM member WHERE id = $1', [m.id]);
			const left = await c.query('SELECT count(*)::int AS n FROM passkey_credential');
			assert.equal(left.rows[0].n, 0, 'passkeys outlived their member');
		} finally {
			await c.query('ROLLBACK');
			c.release();
		}
	}
);
