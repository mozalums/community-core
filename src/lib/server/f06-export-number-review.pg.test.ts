import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { MIGRATIONS } from './migrations';
import { DEFAULT_FIELD_SCHEMA, type FieldDef } from './field-schema';
import { loadExportMembers, memberCsv, readMemberCsv } from './member-export';

const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url }) : null;
const full = { includePrivate: true, includeRemoved: true };
// A row as migration 13 left production's: the Email cell under the key
// `email`, and an unreviewed column under `x.Team` in private_data. The default
// skin declares no email field, so the export is given the default fields plus
// the one the row holds.
const schema: FieldDef[] = [
	...DEFAULT_FIELD_SCHEMA,
	{ key: 'email', label: 'Email', type: 'email', visibility: 'private', role: 'email', column: 'email', order: 15 }
];

type Snapshot = { csv: string; stored: string };

async function migratedCell(json: string): Promise<Snapshot> {
	const c = await pool!.connect();
	try {
		await c.query('BEGIN');
		await c.query('CREATE SCHEMA f06_numeric_review');
		await c.query('SET LOCAL search_path TO f06_numeric_review, public');
		for (const m of MIGRATIONS.filter((m) => m.version <= 13)) await c.query(m.sql);
		const { rows: [group] } = await c.query(
			`INSERT INTO "group" (slug, name) VALUES ('numeric-review', 'Numeric review') RETURNING id`
		);
		await c.query(
			`INSERT INTO member (group_id, email, private_data) VALUES ($1, 'login@example.com', $2::jsonb)`,
			[group.id, `{"email":"login@example.com","x.Team":{"count":${json}}}`]
		);
		const { rows: [row] } = await c.query<{ stored: string }>(
			`SELECT (private_data->'x.Team'->'count')::text AS stored FROM member WHERE group_id = $1`,
			[group.id]
		);
		return { stored: row.stored, csv: memberCsv(await loadExportMembers(c, group.id, full), full, schema) };
	} finally {
		await c.query('ROLLBACK');
		c.release();
	}
}

after(async () => { await pool?.end(); });

test('R9: distinct PostgreSQL JSON integers stay distinct through full export and decode', opts, async () => {
	const a = await migratedCell('9007199254740992');
	const b = await migratedCell('9007199254740993');
	assert.equal(a.stored, '9007199254740992');
	assert.equal(b.stored, '9007199254740993');
	assert.notEqual(a.csv, b.csv, 'different F3-preserved numbers must not produce identical full exports');
	assert.notDeepEqual(readMemberCsv(a.csv, schema), readMemberCsv(b.csv, schema), 'the shared decoder must retain the difference');
});

test('R9: a preserved JSON number outside the Number range must not become null', opts, async () => {
	const a = await migratedCell('1e400');
	const b = await migratedCell('null');
	assert.equal(a.stored, '1' + '0'.repeat(400));
	assert.equal(b.stored, 'null');
	assert.notEqual(a.csv, b.csv, 'a F3-preserved number and null must not produce identical full exports');
	assert.notDeepEqual(readMemberCsv(a.csv, schema), readMemberCsv(b.csv, schema), 'the shared decoder must retain the JSON type');
});
