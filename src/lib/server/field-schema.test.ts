import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as fieldSchema from './field-schema';
import {
	DEFAULT_FIELD_SCHEMA,
	editableFields,
	fieldByRole,
	fieldsFor,
	fieldsWithRole,
	promotedColumns,
	splitData,
	type FieldDef
} from './field-schema';
import { MIGRATIONS } from './migrations';

const ROOT = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// The five places the sheet's header text used to be spelled out.
const FORMER_SITES = [
	'src/routes/group/[slug]/members/[id]/+page.server.ts',
	'src/lib/server/member-edit.ts',
	'src/lib/server/affiliations.ts',
	'src/lib/server/members.ts'
];
// Header text that is not also a schema label, so finding it means a reader
// still keys data by the sheet's column name.
const SHEET_ONLY_HEADERS = [
	"If big city doesn't cut it, add a place",
	'Past/Present Orgs (comma separated)',
	'Hobbies/Interests (comma seperated)',
	'Cell/Mobile Int Dialling Code',
	'Unisex T-Shirt/Hoodie Size',
	'Mens T-Shirt/Hoodie Size',
	'Womens T-Shirt/Hoodie Size',
	'Postal Address'
];
const DENY_LIST = /postal\|address\|whatsapp/;

const m13 = MIGRATIONS.find((m) => m.version === 13);

// ---------------------------------------------------------------------------
// 1: one typed module
// ---------------------------------------------------------------------------

test('R1: DEFAULT_FIELD_SCHEMA is one ordered list with unique keys, labels and orders', () => {
	const keys = DEFAULT_FIELD_SCHEMA.map((f) => f.key);
	const labels = DEFAULT_FIELD_SCHEMA.map((f) => f.label);
	const orders = DEFAULT_FIELD_SCHEMA.map((f) => f.order);
	assert.equal(new Set(keys).size, keys.length, 'a key repeats');
	assert.equal(new Set(labels).size, labels.length, 'a label (the CSV header) repeats');
	assert.deepEqual(
		orders,
		[...orders].sort((a, b) => a - b),
		'the list is not in order'
	);
	for (const f of DEFAULT_FIELD_SCHEMA) {
		assert.match(f.key, /^[a-z][A-Za-z]*$/, `${f.key} is not a stable key`);
		assert.ok(['members', 'private'].includes(f.visibility), `${f.key} has no visibility`);
	}
	assert.ok(Object.isFrozen(DEFAULT_FIELD_SCHEMA));
});

test('R1: no former site spells out a sheet header, and none carries the deny-list', () => {
	for (const path of FORMER_SITES) {
		const src = read(path);
		for (const h of SHEET_ONLY_HEADERS) {
			assert.ok(!src.includes(h), `${path} still names "${h}"`);
		}
		assert.doesNotMatch(src, DENY_LIST, `${path} still carries the deny-list`);
		assert.doesNotMatch(src, /data->>'/, `${path} reads data by a literal key`);
	}
});

test('R1: the schema records no sheet header text', () => {
	const src = read('src/lib/server/field-schema.ts');
	for (const h of SHEET_ONLY_HEADERS) assert.ok(!src.includes(h), `field-schema.ts names "${h}"`);
});

// ---------------------------------------------------------------------------
// 2: role replaces the hardcoded lookups
// ---------------------------------------------------------------------------

// 'R2: affiliations are the fields whose role says so' is in
// src/lib/skin/every-role/field-roles.test.ts: the affiliation constants are
// bound to the running skin, and the default skin declares no affiliation.

test('R2: a role held by no field, or by two, is an error rather than a guess', () => {
	const schema: FieldDef[] = [
		{ key: 'a', label: 'A', type: 'year', visibility: 'members', role: 'tenureStart', order: 1 },
		{ key: 'b', label: 'B', type: 'year', visibility: 'members', role: 'tenureStart', order: 2 }
	];
	assert.throws(() => fieldByRole('tenureStart', schema), /exactly one "tenureStart"/);
	assert.throws(() => fieldByRole('tenureEnd', schema), /found 0/);
});

test('R2: the edit form is the schema’s text fields, in schema order', () => {
	const keys = editableFields().map((f) => f.key);
	assert.ok(keys.indexOf('country') < keys.indexOf('city'), 'city before country');
	for (const role of ['email', 'retired', 'affiliation'] as const) {
		for (const f of fieldsWithRole(role)) assert.ok(!keys.includes(f.key), `${f.key} is editable`);
	}
});

// ---------------------------------------------------------------------------
// 3: private storage is a property of the schema
// ---------------------------------------------------------------------------

test('R3: a private field goes to private_data whatever its name says', () => {
	const schema: FieldDef[] = [
		{ key: 'shoeSize', label: 'Shoe Size', type: 'text', visibility: 'private', order: 1 },
		{ key: 'handle', label: 'Handle', type: 'text', visibility: 'members', order: 2 }
	];
	const { data, privateData } = splitData({ shoeSize: '44', handle: 'ada' }, schema);
	assert.deepEqual(data, { handle: 'ada' });
	assert.deepEqual(privateData, { shoeSize: '44' });
});

test('R3: every private field in the default schema is stored privately', () => {
	const all = Object.fromEntries(DEFAULT_FIELD_SCHEMA.map((f) => [f.key, 'v']));
	const { data, privateData } = splitData(all);
	for (const f of DEFAULT_FIELD_SCHEMA) {
		const bag = f.visibility === 'private' ? privateData : data;
		assert.ok(f.key in bag, `${f.key} landed in the wrong column`);
	}
});

test('B28: the search allowlist is the set of keys a profile shows a non-admin', () => {
	const schema: FieldDef[] = [
		{ key: 'mobile', label: 'Cell/Mobile Number', type: 'text', visibility: 'private', order: 1 },
		{ key: 'handle', label: 'Handle', type: 'text', visibility: 'members', order: 2 },
		{ key: 'size', label: 'T-Shirt/Hoodie Size', type: 'text', visibility: 'private', order: 3 }
	];
	assert.deepEqual(fieldSchema.membersVisibleKeys(schema), ['handle']);
	const shown = DEFAULT_FIELD_SCHEMA.filter((f) => f.visibility === 'members').map((f) => f.key);
	assert.deepEqual(fieldSchema.membersVisibleKeys(), shown);
	assert.ok(!fieldSchema.membersVisibleKeys().includes('phone'), 'the private phone is searchable');
});

test('R3: the search function migration 13 installs has no key filter at all', () => {
	assert.ok(m13);
	const fn = m13.sql.split('CREATE OR REPLACE FUNCTION member_search_values')[1].split('$$;')[0];
	assert.doesNotMatch(fn, /\bkey\b/, 'member_search_values still filters by key');
	assert.doesNotMatch(fn, DENY_LIST);
	assert.match(m13.sql, /ADD COLUMN IF NOT EXISTS private_data jsonb NOT NULL/);
	assert.match(fn, /IMMUTABLE/);
});

// ---------------------------------------------------------------------------
// 4: migration 13 is fixed text
// ---------------------------------------------------------------------------

test('R4: migration 13 is a literal, not generated from the schema', () => {
	const src = read('src/lib/server/migrations.ts');
	assert.doesNotMatch(src, /from '\$lib\/server\/field-schema'|from '\.\/field-schema'/);
	assert.ok(m13 && !m13.sql.includes('${'), 'migration 13 interpolates');
});

// ---------------------------------------------------------------------------
// 5: unmapped headers survive as x.*
// ---------------------------------------------------------------------------

test('R5: the loader synthesizes a private definition for every x.* key it meets', () => {
	const fields = fieldsFor(['x.Favourite Colour', 'firstName', 'x.Badge No', 'stray']);
	const extra = fields.filter((f) => f.key.startsWith('x.'));
	assert.deepEqual(
		extra.map((f) => [f.key, f.label, f.visibility]),
		[
			['x.Badge No', 'Badge No', 'private'],
			['x.Favourite Colour', 'Favourite Colour', 'private']
		]
	);
	assert.equal(fields.at(-1)?.key, 'x.Favourite Colour', 'x.* fields sort after the schema');
	assert.ok(!fields.some((f) => f.key === 'stray'), 'only x.* keys are synthesized');
	assert.deepEqual(splitData({ 'x.Badge No': '7' }).privateData, { 'x.Badge No': '7' });
});

// ---------------------------------------------------------------------------
// 7: the readers and the migration ship together
// ---------------------------------------------------------------------------

test('R7: docs/deployment.md says how migration 13 is applied and what happens otherwise', () => {
	const section =
		read('docs/deployment.md')
			.split(/^## Migrations$/m)[1]
			?.split(/^#{2,3} /m)[0] ?? '';
	assert.match(section, /migration 13/i);
	assert.match(section, /(?:docker compose|\bdc) stop lorem-host/, 'no instruction to stop the app');
	assert.match(section, /LOREM_WRITERS_STOPPED/, 'the runner guard is not documented');
	assert.doesNotMatch(
		section.replace(/\s+/g, ' '),
		/accepts? the window/,
		'R7 requires the app stopped; no path may accept a live window'
	);
	assert.match(section, /10 through 13/, 'the release applying 10-13 together is not stated');
	// The snapshot rehearsal needs the header table, which only the build that
	// converted the one header-keyed database carries, so core's page rehearses
	// the gated migration against a restored dump instead.
	assert.match(section, /LOREM_WRITERS_STOPPED=restore_check/, 'no way to rehearse on a restored backup');
});

test('R7: promoted columns derive from the fields that name them', () => {
	// The default skin promotes a whole name and a city, and no address.
	assert.deepEqual(promotedColumns({ name: 'Ada Byron', city: 'London', bio: 'x' }), {
		email: null,
		name: 'Ada Byron',
		city: 'London'
	});
	// Two fields naming one column are joined in schema order.
	assert.deepEqual(
		promotedColumns({ lastName: 'Byron', firstName: 'Ada', city: 'London', email: 'a@b.c' }, [
			{ key: 'firstName', label: 'First', type: 'text', visibility: 'members', column: 'name', order: 1 },
			{ key: 'lastName', label: 'Last', type: 'text', visibility: 'members', column: 'name', order: 2 },
			{ key: 'email', label: 'Email', type: 'text', visibility: 'private', column: 'email', order: 3 },
			{ key: 'city', label: 'City', type: 'text', visibility: 'members', column: 'city', order: 4 }
		]),
		{ email: 'a@b.c', name: 'Ada Byron', city: 'London' }
	);
});

// ---------------------------------------------------------------------------
// 10: Dash Access and Dash Permissions are kept, private, and read by nothing
// ---------------------------------------------------------------------------

function sources(dir: string): string[] {
	return readdirSync(join(ROOT, dir)).flatMap((name) => {
		const p = join(dir, name);
		if (statSync(join(ROOT, p)).isDirectory()) return sources(p);
		return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
	});
}

// A read of a dash key out of a member's stored fields, in any of the forms TS
// or SQL would spell it.
const DASH_READ =
	/(\bdata|privateData|private_data|values)\s*(\?\.|\.|\[\s*['"`]|->>?\s*['"`])\s*dash(Access|Permissions)\b/;

test('R10: nothing in src or scripts reads either dash key from member data', () => {
	const files = [...sources('src'), ...sources('scripts')];
	assert.ok(files.length > 50, 'the scan found nothing to scan');
	const readers = files.filter((p) => DASH_READ.test(read(p)));
	assert.deepEqual(readers, []);
	assert.ok(DASH_READ.test("m.privateData['dashPermissions']"), 'the pattern misses a read');
	assert.ok(DASH_READ.test("data->>'dashAccess'"), 'the pattern misses a SQL read');
	assert.ok(!DASH_READ.test('columnMap.dashPermissions'), 'the pattern matches sheet config');
});

// ---------------------------------------------------------------------------
// 11, 12: the readme
// ---------------------------------------------------------------------------

// The tables and the field reference are two sections of one page now.
const dataModel = () => read('docs/data-model.md');

test('R11: the readme says member.visibility and source_row are gone, and why visibility went', () => {
	const s = dataModel();
	assert.match(s, /Migration 15 dropped/);
	assert.match(s, /`visibility`[^\n]*(no reader|unused|read by nothing)/i);
	assert.match(s, /`source_row`/);
});

test('R12: the readme data model names the jsonb keys and where the fields live', () => {
	const s = dataModel();
	assert.match(s, /`private_data`/);
	assert.match(s, /src\/lib\/server\/field-schema\.ts/);
	assert.match(s, /DEFAULT_FIELD_SCHEMA/);
	assert.match(s, /`x\.<original header>`|`x\.`/);
	// The table core's page prints is the default skin's, and says so; the
	// community's own table is in its runbook. That every field of each is
	// listed is checked in src/lib/skin/skin.test.ts.
	assert.match(s, /`skin\/default`/);
});

// ---------------------------------------------------------------------------
// 13: nothing left that replays a legacy column map
// ---------------------------------------------------------------------------

test('R13: migration 13 reads no column_map and carries no alias, name-recovery or split logic', () => {
	assert.ok(m13);
	// Header matching is byte for byte: no case folding or whitespace collapse
	// of a header, and nothing writes a typed column.
	const banned = [/column_map/, /promoted_map/, /alias/i, /lower\(e\.key/, /lc_/, /regexp_/];
	banned.push(/SET\s+(name|city|linkedin|email)\s*=/);
	for (const b of banned) {
		assert.doesNotMatch(m13.sql, b, `migration 13 still matches ${b}`);
	}
});

test('R13: the scripts/f3-* review files and the promoted_map alias mechanism are gone', () => {
	assert.deepEqual(
		readdirSync(join(ROOT, 'scripts')).filter((n) => n.startsWith('f3-')),
		[]
	);
	for (const gone of ['storageKeyOf', 'toStorageKeys', 'resolveProjection', 'componentOf']) {
		assert.ok(!(gone in fieldSchema), `field-schema still exports ${gone}`);
	}
	const files = sources('src').filter((p) => !p.endsWith('migrations.ts'));
	assert.deepEqual(
		files.filter((p) => /promoted_map|\.alias\b/.test(read(p))),
		[],
		'a reader still resolves fields through a per-group alias'
	);
});
