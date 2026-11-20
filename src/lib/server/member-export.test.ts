import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseCsv } from './csv-core';
import { DEFAULT_FIELD_SCHEMA, splitData, type FieldDef } from './field-schema';
import {
	LOGIN_KEY,
	STATUS_KEY,
	STATUS_LABEL,
	columnHeading,
	columnKey,
	decodeCell,
	encodeCell,
	exportFilename,
	exportOptionsFrom,
	loadExportMembers,
	memberCsv,
	parseJsonExact,
	readMemberCsv,
	type ExportMember,
	type ExportOptions
} from './member-export';

// A stored number as the loader hands it over: its digits, not a double.
const n = (digits: string) => JSON.rawJSON(digits);

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

const DEFAULT: ExportOptions = { includePrivate: false, includeRemoved: false };
const PRIVATE: ExportOptions = { includePrivate: true, includeRemoved: false };
const REMOVED: ExportOptions = { includePrivate: false, includeRemoved: true };
const FULL: ExportOptions = { includePrivate: true, includeRemoved: true };

function member(email: string, status: string, values: Record<string, string>): ExportMember {
	const { data, privateData } = splitData(values);
	return { email, status, data, privateData };
}

// The default skin keeps no copy of the address in the profile. A skin that
// does gets a second, stored column, so the tests of that column run on the
// default fields plus one email-role field.
const WITH_EMAIL: readonly FieldDef[] = [
	...DEFAULT_FIELD_SCHEMA,
	{
		key: 'email',
		label: 'Email',
		type: 'email',
		visibility: 'private',
		role: 'email',
		column: 'email',
		order: 15
	}
];

const ADA = member('ada@example.com', 'active', {
	name: 'Ada Lovelace',
	bio: 'Line one, with a comma.\nLine "two".\n\n=not a formula',
	country: 'Switzerland',
	city: 'Zürich',
	phone: '-7700 900000',
	'x.Postal': '12 St James Sq\nLondon',
	'x.Team': "'Analytical"
});
const GONE = {
	...member('gone@example.com', 'removed', { name: 'Gone', 'x.Years active': '3' }),
	// Migration 13 put this x.* key in data rather than private_data.
	data: { name: 'Gone', 'x.Full Name': 'Gone Person' }
};

const headings = (csv: string) => parseCsv(csv)[0];

test('R2: the column headings are the schema labels, in schema order', () => {
	// The sign-in address leads a skin that keeps no email-role field.
	const members = DEFAULT_FIELD_SCHEMA.filter((f) => f.visibility === 'members');
	assert.deepEqual(headings(memberCsv([ADA], DEFAULT)), [
		'Email',
		...[...members].sort((a, b) => a.order - b.order).map((f) => f.label)
	]);
	assert.deepEqual(headings(memberCsv([], PRIVATE)), [
		'Email',
		...[...DEFAULT_FIELD_SCHEMA].sort((a, b) => a.order - b.order).map((f) => f.label)
	]);
	// With an email-role field the address sits where that field does, and a
	// private file adds the stored Email field beside it.
	const ordered = [...WITH_EMAIL].sort((a, b) => a.order - b.order);
	assert.deepEqual(
		headings(memberCsv([ADA], DEFAULT, WITH_EMAIL)),
		ordered.filter((f) => f.visibility === 'members' || f.role === 'email').map((f) => f.label)
	);
	assert.deepEqual(
		headings(memberCsv([], PRIVATE, WITH_EMAIL)),
		ordered.flatMap((f) => (f.role === 'email' ? [f.label, `${f.label} (stored)`] : [f.label]))
	);
	// One string in one place: a relabeled field relabels the column.
	const relabeled = DEFAULT_FIELD_SCHEMA.map((f) =>
		f.key === 'bio' ? { ...f, label: 'About' } : f
	);
	assert.ok(headings(memberCsv([ADA], DEFAULT, relabeled)).includes('About'));
});

test('R3: the default file is active members and the members-visible fields', async () => {
	const seen: string[] = [];
	const db = {
		query: async (text: string) => {
			seen.push(text);
			return { rows: [] };
		}
	};
	await loadExportMembers(db, 'g-1', DEFAULT);
	await loadExportMembers(db, 'g-1', FULL);
	assert.match(seen[0], /AND status = 'active'/);
	assert.match(seen[0], /'\{\}' AS private_data/, 'private_data is not even selected');
	assert.doesNotMatch(seen[1], /status = 'active'|'\{\}'::jsonb/);

	const rows = parseCsv(memberCsv([ADA], DEFAULT));
	assert.equal(rows.length, 2);
	const [head, ada] = rows;
	const at = (label: string) => ada[head.indexOf(label)];
	assert.equal(at('Email'), 'ada@example.com');
	assert.equal(at('City'), 'Zürich');
	for (const label of DEFAULT_FIELD_SCHEMA.filter(
		(f) => f.visibility === 'private' && f.role !== 'email'
	).map((f) => f.label)) {
		assert.ok(!head.includes(label), `${label} is private`);
	}
	assert.ok(!head.includes('Team') && !head.includes(STATUS_LABEL));
	assert.doesNotMatch(memberCsv([ADA], DEFAULT), /St James|7700/);
});

test('R3: the private flag adds the private columns and renames the file', () => {
	const [head, ada] = parseCsv(memberCsv([ADA], PRIVATE));
	const at = (label: string) => ada[head.indexOf(label)];
	assert.equal(at('Postal'), '12 St James Sq\nLondon');
	assert.equal(at('Phone'), '-7700 900000');
	assert.equal(at('Team'), "'Analytical", 'an x.* column under its original header');
	assert.equal(head.at(-1), 'Team', 'x.* columns come after every declared field');

	const day = new Date('2026-11-15T12:00:00Z');
	assert.equal(exportFilename('example', DEFAULT, day), 'example-members-2026-11-15.csv');
	assert.equal(exportFilename('example', PRIVATE, day), 'example-members-PRIVATE-2026-11-15.csv');
	assert.equal(
		exportFilename('example', FULL, day),
		'example-members-PRIVATE-with-removed-2026-11-15.csv'
	);
	assert.equal(exportFilename('a"b\r\n', DEFAULT, day), 'a_b__-members-2026-11-15.csv');
});

test('R3: the removed flag adds removed members and a Status column', () => {
	const rows = parseCsv(memberCsv([ADA, GONE], REMOVED));
	assert.equal(rows[0].at(-1), STATUS_LABEL);
	assert.deepEqual(
		rows.slice(1).map((r) => [r[rows[0].indexOf('Email')], r.at(-1)]),
		[
			['ada@example.com', 'active'],
			['gone@example.com', 'removed']
		]
	);
});

test('R3: only a literal 1 turns a variant on', () => {
	assert.deepEqual(exportOptionsFrom(new URLSearchParams('')), DEFAULT);
	assert.deepEqual(exportOptionsFrom(new URLSearchParams('private=1&removed=1')), FULL);
	assert.deepEqual(exportOptionsFrom(new URLSearchParams('private=yes&removed=true')), DEFAULT);
});

// The importer's job, from the file and the schema alone. The sign-in address
// comes back on its own and is compared with member.email; the stored values
// are compared with what is stored, untouched.
const readBack = (csv: string, schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA) =>
	readMemberCsv(csv, schema);
const stored = (m: ExportMember) => ({ ...m.data, ...m.privateData });

function assertRoundTrip(
	roster: ExportMember[],
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
) {
	const csv = memberCsv(roster, FULL, schema);
	const back = readBack(csv, schema);
	assert.equal(back.length, roster.length);
	for (const [i, m] of roster.entries()) {
		assert.equal(back[i].email, m.email, 'the sign-in address comes back as itself');
		assert.deepEqual(back[i].values, stored(m), `${m.email} comes back cell for cell`);
		assert.equal(back[i].status, m.status);
	}
	// What came back, exported again, is the same file: a zero-row diff.
	const again = back.map(({ email, values, status }) => {
		const { data, privateData } = splitData(values, schema);
		return { email, status: String(status), data, privateData };
	});
	assert.equal(memberCsv(again, FULL, schema), csv);
}

test('R9: an unmodified full export reads back to exactly what is stored', () => {
	assertRoundTrip([ADA, GONE]);
	assertRoundTrip([ADA, GONE], WITH_EMAIL);
});

const LOGIN = (emailCopy: unknown): ExportMember => ({
	email: 'login@example.com',
	status: 'active',
	data: { name: 'Ada' },
	privateData: { email: emailCopy, 'x.Login Address': 'login@example.com' }
});

test('R9: the stored Email field and the sign-in address decode separately', () => {
	for (const copy of [
		'old-one@example.com',
		'old-two@example.com',
		{ previous: 'old-one@example.com' },
		['a@example.com', 'b@example.com'],
		'json:old@example.com',
		'login@example.com'
	]) {
		const [back] = readBack(memberCsv([LOGIN(copy)], FULL, WITH_EMAIL), WITH_EMAIL);
		assert.equal(back.email, 'login@example.com');
		assert.deepEqual(back.values.email, copy, JSON.stringify(copy));
		assertRoundTrip([LOGIN(copy), ADA, GONE], WITH_EMAIL);
	}
	// A member with no stored Email gets none back, not the sign-in address.
	const none: ExportMember = { ...LOGIN(undefined), privateData: { 'x.Login Address': 'l@x' } };
	const [back] = readBack(memberCsv([none], FULL, WITH_EMAIL), WITH_EMAIL);
	assert.equal(back.email, 'login@example.com');
	assert.ok(!Object.hasOwn(back.values, 'email'));
	assertRoundTrip([none, ADA], WITH_EMAIL);
	// Nor is the stored value read into the sign-in address on any variant.
	for (const opts of [DEFAULT, PRIVATE, REMOVED, FULL]) {
		const [row] = readBack(memberCsv([LOGIN('old@example.com')], opts, WITH_EMAIL), WITH_EMAIL);
		assert.equal(row.email, 'login@example.com');
		assert.equal(row.values.email, opts.includePrivate ? 'old@example.com' : undefined);
	}
	assert.doesNotMatch(memberCsv([LOGIN('old@example.com')], DEFAULT, WITH_EMAIL), /old@example/);
	// A skin with no email-role field has no stored column to confuse with it:
	// the address is the Email column and nothing else is.
	const [plain] = readBack(memberCsv([ADA], FULL));
	assert.equal(plain.email, 'ada@example.com');
	assert.ok(!Object.hasOwn(plain.values, 'email'));
});

test('R9: the stored Email heading is reserved like every other heading', () => {
	assert.equal(columnHeading(LOGIN_KEY, WITH_EMAIL), 'Email');
	assert.equal(columnHeading('email', WITH_EMAIL), 'Email (stored)');
	assert.equal(columnKey('Email', WITH_EMAIL), LOGIN_KEY);
	assert.equal(columnKey('Email (stored)', WITH_EMAIL), 'email');
	assert.equal(columnHeading('x.Email (stored)', WITH_EMAIL), 'x.Email (stored)');
	assert.equal(columnHeading('x.email (STORED)', WITH_EMAIL), 'x.email (STORED)');
	assert.equal(columnKey('x.Email (stored)', WITH_EMAIL), 'x.Email (stored)');
	const clash = [
		...WITH_EMAIL,
		{ key: 'k', label: 'email (stored)', type: 'text', visibility: 'members', order: 999 } as FieldDef
	];
	assert.throws(() => columnHeading('x.Foo', clash), /cannot be told apart/);
	const loginKey = [
		...DEFAULT_FIELD_SCHEMA,
		{ key: LOGIN_KEY, label: 'L', type: 'text', visibility: 'members', order: 999 } as FieldDef
	];
	assert.throws(() => columnKey('Foo', loginKey), /reserves/);
	assert.throws(() => readMemberCsv('Name\r\nAda\r\n'), /no Email column/);
	// Without an email-role field the login heading is still reserved, and no
	// stored column exists for a key or a heading to claim.
	assert.equal(columnHeading(LOGIN_KEY), 'Email');
	assert.equal(columnKey('Email'), LOGIN_KEY);
	assert.equal(columnHeading('x.Email'), 'x.Email');
	assert.throws(() => columnHeading('email'), /"email" is neither a schema field/);
	assert.equal(columnKey('Email (stored)'), 'x.Email (stored)');
	const second = [
		...DEFAULT_FIELD_SCHEMA,
		{ key: 'k', label: 'email', type: 'text', visibility: 'members', order: 999 } as FieldDef
	];
	assert.throws(() => columnHeading('x.Foo', second), /cannot be told apart/);
});

const ODD_KEYS = [
	'x.Status',
	'x.x.Status',
	'x.x.x.Status',
	'x.Email',
	'x.email',
	'x.Email (stored)',
	'x.STATUS',
	'x. Status',
	'x.Status ',
	'x.',
	'x.X.Foo',
	'x.Name',
	'x.name',
	'x.Foo',
	'x.Team, "A"'
];

test('R9: every preserved key gets its own heading, decoded without the roster', () => {
	for (const schema of [DEFAULT_FIELD_SCHEMA, WITH_EMAIL]) {
		const headings = ODD_KEYS.map((k) => columnHeading(k, schema));
		assert.equal(new Set(headings).size, headings.length);
		for (const [i, k] of ODD_KEYS.entries()) {
			assert.equal(
				columnKey(headings[i], schema),
				k,
				`${k} is headed ${JSON.stringify(headings[i])}`
			);
		}
		for (const f of schema) assert.equal(columnKey(columnHeading(f.key, schema), schema), f.key);
		assert.equal(columnKey(STATUS_LABEL, schema), STATUS_KEY);
		assert.equal(columnKey(columnHeading(LOGIN_KEY, schema), schema), LOGIN_KEY);
	}
	// The original header text heads an x.* column unless it could be misread.
	assert.equal(columnHeading('x.Foo'), 'Foo');
	assert.equal(columnHeading('x.Status'), 'x.Status');
	assert.equal(columnHeading('x.x.Status'), 'x.x.Status');
	assert.equal(columnHeading('x.name'), 'x.name');
	// A column an admin adds is an x.* column, as a sheet column was.
	assert.equal(columnKey('Pronouns'), 'x.Pronouns');
});

test('R9: a full export of every odd key and value type round-trips', () => {
	const odd: ExportMember = {
		...ADA,
		data: { ...ADA.data, bio: ['a,b', 'c'], country: n('1999'), 'x.Full Name': null },
		privateData: {
			...ADA.privateData,
			...Object.fromEntries(ODD_KEYS.map((k, i) => [k, `v${i}`])),
			'x.Team': { unit: 'ops', tags: ['x', 'y'], lead: null, size: n('9007199254740993') },
			'x.Huge': [n('1e400'), n('1.10'), '1e400'],
			'x.Flag': true,
			phone: 'json:{"not":"structured"}',
			'x.Postal': 'json:'
		}
	};
	assertRoundTrip([odd, GONE]);
	assertRoundTrip([odd, GONE], WITH_EMAIL);
});

test('R9: ordinary strings are written as they are, and only they', () => {
	assert.equal(encodeCell('Ada, "the Countess"'), 'Ada, "the Countess"');
	assert.equal(encodeCell(''), '');
	assert.equal(encodeCell(undefined), '');
	assert.equal(encodeCell({ unit: 'ops' }), 'json:{"unit":"ops"}');
	assert.equal(encodeCell(['a,b', 'c']), 'json:["a,b","c"]');
	assert.equal(encodeCell(1999), 'json:1999');
	assert.equal(encodeCell(null), 'json:null');
	assert.equal(encodeCell('json:1999'), 'json:"json:1999"');
	for (const v of ['json:1999', 'json:', 'JSON:x', '1999', null, false, 'false', [], {}]) {
		assert.deepEqual(decodeCell(encodeCell(v)), v);
	}
	// A number decodes to its digits as written, never to a double.
	assert.deepEqual(decodeCell(encodeCell(1999)), n('1999'));
	for (const digits of ['9007199254740993', '1e400', '1.10', '-0']) {
		assert.equal(encodeCell(decodeCell(`json:${digits}`)), `json:${digits}`);
		assert.equal(encodeCell(parseJsonExact(`{"a":[${digits}]}`)), `json:{"a":[${digits}]}`);
	}
	assert.notDeepEqual(decodeCell('json:9007199254740992'), decodeCell('json:9007199254740993'));
	assert.notDeepEqual(decodeCell('json:1e400'), decodeCell('json:null'));
	assert.notDeepEqual(decodeCell('json:1999'), decodeCell('json:"1999"'));
	assert.throws(() => decodeCell('json:{oops'), /does not hold valid JSON/);
});

test('R9: a stored key the file cannot name stops the full export by name', () => {
	const stray = { ...ADA, privateData: { ...ADA.privateData, 'Full Name': 'Ada' } };
	assert.throws(() => memberCsv([stray], FULL), /"Full Name" is neither a schema field/);
	assert.throws(() => memberCsv([stray], PRIVATE), /"Full Name"/);
	// A variant that prints no private field promises nothing about it.
	assert.doesNotThrow(() => memberCsv([stray], DEFAULT));
});

test('R9: a schema whose labels could be misread as another heading is refused', () => {
	const base = DEFAULT_FIELD_SCHEMA.slice(0, 3);
	const extra = (f: Partial<FieldDef>) => [
		...base,
		{ key: 'k', label: 'K', type: 'text', visibility: 'members', order: 999, ...f } as FieldDef
	];
	assert.throws(() => columnHeading('x.Foo', extra({ label: 'status' })), /cannot be told apart/);
	assert.throws(() => columnHeading('x.Foo', extra({ label: 'x.Thing' })), /cannot be told apart/);
	assert.throws(
		() => columnHeading('x.Foo', extra({ label: ' name' })),
		/cannot be told apart/
	);
	assert.throws(() => columnKey('Foo', extra({ key: STATUS_KEY })), /reserves/);
	assert.doesNotThrow(() => columnHeading('x.Foo', extra({})));
});

test('R9: the round-trip contract is stated in the code and docs/features.md', () => {
	const sentence = /importing an unmodified full export (\([^)]*\) )?produces a zero-row diff/i;
	const prose = (p: string) =>
		read(p)
			.replace(/\n\s*\/\/ ?/g, ' ')
			.replace(/\s+/g, ' ');
	assert.match(prose('src/lib/server/member-export.ts'), sentence);
	assert.match(prose('src/lib/server/csv-core.ts'), sentence);
	assert.match(prose('docs/features.md'), sentence);
});

test('R8: scripts/export-members.ts runs the shared exporter over scriptPool()', () => {
	const src = read('scripts/export-members.ts');
	assert.match(src, /import \{ scriptPool \} from '\.\/db'/);
	assert.match(src, /scriptPool\(\)/);
	assert.match(src, /memberCsv\(/);
	assert.match(src, /auditIn\(/);
	const pkg = JSON.parse(read('package.json'));
	assert.equal(pkg.scripts['export-members'], 'tsx --env-file=.env scripts/export-members.ts');
});

test('R8: the script refuses bad arguments before it touches a database', () => {
	const script = new URL('../../../scripts/export-members.ts', import.meta.url).pathname;
	for (const args of [[], ['--private'], ['slug', '--bogus'], ['slug', '--out']]) {
		const r = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
			encoding: 'utf8',
			// Unroutable: a script that reached for the database would hang here
			// rather than fail fast, and the timeout would catch it.
			env: { ...process.env, POSTGRES_HOST: '192.0.2.1' },
			timeout: 20_000
		});
		assert.equal(r.status, 1, `${JSON.stringify(args)}: ${r.stderr}`);
		assert.match(r.stderr, /usage: export-members <slug>/);
		assert.equal(r.stdout, '');
	}
});

test('R11: docs/features.md documents the file format', () => {
	const readme = read('docs/features.md');
	const start = readme.indexOf('\n## Roster export\n');
	assert.ok(start > 0, 'docs/features.md has a Roster export section');
	const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
	for (const must of [
		/byte order mark|BOM/i,
		/UTF-8/,
		/RFC 4180/,
		/label/i,
		/private=1/,
		/removed=1/,
		/Status/,
		/apostrophe/i,
		/'=SUM/,
		/PRIVATE/,
		/audit/i,
		/export-members/
	]) {
		assert.match(section, must);
	}
});
