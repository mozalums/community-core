import assert from 'node:assert/strict';
import { after, before, test, mock } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// What the export does with a role the default skin leaves out: a field set
// that keeps a copy of the address as an email-role field gets a stored column
// beside the sign-in address, and the export, which binds the field schema
// when it loads, has to carry both against real rows. The script that wraps
// these calls runs on the default skin in
// src/lib/server/member-export.pg.test.ts.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const { parseCsv } = await import('../../server/csv-core');
const { loadExportMembers, memberCsv, readMemberCsv } = await import('../../server/member-export');
const { migrate } = await import('../../server/migrations');

const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'export-every-role-test';
let groupId = '';

// What scripts/export-members.ts runs between its BEGIN and its COMMIT.
async function exportCsv(opts: { includePrivate: boolean; includeRemoved: boolean }) {
	const client = await pool!.connect();
	try {
		return memberCsv(await loadExportMembers(client, groupId, opts), opts);
	} finally {
		client.release();
	}
}

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, 'Export every-role test')
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[SLUG]
	);
	groupId = rows[0].id;
	await pool.query('DELETE FROM member WHERE group_id = $1', [groupId]);
	const insert = (email: string, data: object, priv: object) =>
		pool!.query(
			`INSERT INTO member (group_id, email, name, data, private_data, status)
			 VALUES ($1, $2, 'n', $3::jsonb, $4::jsonb, 'active')`,
			[groupId, email, JSON.stringify(data), JSON.stringify(priv)]
		);
	await insert(
		'ada@example.com',
		{ givenName: 'Ada', staff: 'TRUE' },
		{ email: 'ada@example.com', phone: '-7700' }
	);
	// A stored Email that is not the sign-in address, and not an address at all.
	await insert(
		'zoe@example.com',
		{ givenName: 'Zoë' },
		{ email: { previous: 'old@example.com' }, 'x.Login Address': 'zoe@example.com' }
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
	'every-role: the export carries the sign-in address and the stored Email field as two columns that read back to the database',
	opts,
	async () => {
		const full = await exportCsv({ includePrivate: true, includeRemoved: false });
		const [head] = parseCsv(full);
		assert.deepEqual(head.slice(0, 4), ['Given name', 'Family name', 'Email', 'Email (stored)']);

		const back = readMemberCsv(full);
		assert.deepEqual(
			back.map((m) => [m.email, m.values.email]),
			[
				['ada@example.com', 'ada@example.com'],
				['zoe@example.com', { previous: 'old@example.com' }]
			]
		);
		for (const m of back) {
			const { rows } = await pool!.query<{ stored: string; decoded: string }>(
				`SELECT (data || private_data)::text AS stored, $3::jsonb::text AS decoded
				   FROM member WHERE group_id = $1 AND email = $2`,
				[groupId, m.email, JSON.stringify(m.values)]
			);
			assert.equal(rows[0].decoded, rows[0].stored, `${m.email} does not decode to what is stored`);
		}

		// The default variant keeps the sign-in address and drops the stored one.
		const plain = await exportCsv({ includePrivate: false, includeRemoved: false });
		const [plainHead, ...rows] = parseCsv(plain);
		assert.ok(plainHead.includes('Email') && !plainHead.includes('Email (stored)'));
		assert.deepEqual(
			rows.map((r) => r[plainHead.indexOf('Email')]),
			['ada@example.com', 'zoe@example.com']
		);
		assert.doesNotMatch(plain, /old@example|7700/);
	}
);
