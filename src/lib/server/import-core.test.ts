import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
	MAX_IMPORT_ROWS,
	canonical,
	comparable,
	confirmPercentFrom,
	decodeUpload,
	diffDigest,
	previewView,
	diffImport,
	gateSatisfied,
	parseImport,
	removalGate,
	sniffDelimiter,
	type ImportMode,
	type RosterMember
} from './import-core';
import { DEFAULT_FIELD_SCHEMA, type FieldDef } from './field-schema';
import { memberCsv, parseJsonExact, type ExportMember } from './member-export';

// The pure half of the roster import: what a file means, what it would change,
// and when the change is refused. member-import.test.ts drives the same
// decisions through the SQL.

const member = (
	email: string,
	data: Record<string, unknown> = {},
	privateData: Record<string, unknown> = {},
	status = 'active'
): RosterMember & ExportMember => ({ id: `id-${email}`, email, status, data, privateData });

function roster(n: number): RosterMember[] {
	return Array.from({ length: n }, (_, i) => member(`m${i}@example.com`, { name: `M${i}` }));
}

function csvOf(rows: string[][]): string {
	return rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
}

function plan(
	text: string,
	current: RosterMember[],
	mode: ImportMode,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
) {
	const keys = new Set(
		current.flatMap((m) => [...Object.keys(m.data), ...Object.keys(m.privateData)])
	);
	const parsed = parseImport(text, { mode, storedKeys: keys, schema });
	return { parsed, diff: diffImport(parsed, current, mode) };
}

// ---------------------------------------------------------------------------
// R15, the centrepiece: an unmodified export reads back as no change at all.
// ---------------------------------------------------------------------------

const FIXTURE: (RosterMember & ExportMember)[] = [
	member(
		'Ada@Example.com',
		{
			name: 'Ada Lovelace',
			bio: 'line one\nline two, with a comma and "quotes"',
			country: '=SUM(A1:A9)',
			city: '+44 London',
			'x.Tags': ['a,b', 'c'],
			'x.Shoe': "'tis"
		},
		{
			phone: '-07700 900000',
			'x.Postal': '@12 St James Sq',
			'x.Notes': 'json:literal'
		}
	),
	member('bob@example.com', { name: 'Bob', country: 2004, 'x.Listed': 'TRUE' }, {}),
	member('gone@example.com', { name: 'Gone' }, { phone: 'somewhere' }, 'removed'),
	member('zoe@example.com', { name: 'Zoë Ó Briain' }, { 'x.Size': 'M' })
];

// A skin that keeps a copy of the address in the profile exports it as a
// second, stored column. The round trip holds for that column as well.
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
const FIXTURE_WITH_EMAIL = FIXTURE.map((m, i) =>
	i === 0 ? { ...m, privateData: { ...m.privateData, email: 'ada@old.example' } } : m
);
const VARIANTS = [
	{ schema: DEFAULT_FIELD_SCHEMA, fixture: FIXTURE },
	{ schema: WITH_EMAIL, fixture: FIXTURE_WITH_EMAIL }
];

test('R15: a full export, parsed and diffed in replace mode, adds, changes and removes nothing', () => {
	for (const { schema, fixture } of VARIANTS) {
		const text = memberCsv(fixture, { includePrivate: true, includeRemoved: true }, schema);
		// The guard really is in play: the file on disk carries the apostrophes.
		assert.match(text, /'=SUM\(A1:A9\)/);
		assert.match(text, /'\+44 London/);
		const { parsed, diff } = plan(text, fixture, 'replace', schema);
		assert.deepEqual(parsed.errors, []);
		assert.deepEqual(parsed.warnings, []);
		assert.deepEqual(diff.added, []);
		assert.deepEqual(diff.changed, []);
		assert.deepEqual(diff.removed, []);
		assert.equal(diff.unchanged, fixture.length);
		const guarded = parsed.rows.find((r) => r.email === 'Ada@Example.com')!.values.country;
		assert.equal(guarded, '=SUM(A1:A9)', 'the formula guard is undone exactly once');
	}
	assert.match(
		memberCsv(FIXTURE_WITH_EMAIL, { includePrivate: true, includeRemoved: true }, WITH_EMAIL),
		/ada@old\.example/,
		'the stored address is in the file the second variant read back'
	);
});

test('R15: the default and private exports read back as no change in either mode', () => {
	for (const { schema, fixture } of VARIANTS) {
		for (const includePrivate of [false, true]) {
			const text = memberCsv(
				fixture.filter((m) => m.status === 'active'),
				{ includePrivate, includeRemoved: false },
				schema
			);
			for (const mode of ['merge', 'replace'] as const) {
				const { diff } = plan(text, fixture, mode, schema);
				assert.equal(
					diff.added.length + diff.changed.length + diff.removed.length,
					0,
					`${mode}/${includePrivate}`
				);
			}
		}
	}
});

// ---------------------------------------------------------------------------
// R1: merge never removes.
// ---------------------------------------------------------------------------

test('R1: merge leaves every member absent from the file alone, and replace removes them', () => {
	const current = roster(10);
	const text = csvOf([
		['Email', 'City'],
		['m0@example.com', 'Paris']
	]);
	const merge = plan(text, current, 'merge').diff;
	assert.equal(merge.removed.length, 0);
	assert.equal(merge.changed.length, 1);
	const replace = plan(text, current, 'replace').diff;
	assert.equal(replace.removed.length, 9);
	assert.ok(replace.removed.every((r) => r.via === 'absent'));
});

test('R1: merge ignores a Status column, with a warning, and never changes who is active', () => {
	const current = [member('a@example.com'), member('b@example.com', {}, {}, 'removed')];
	const text = csvOf([
		['Email', 'Status'],
		['a@example.com', 'removed'],
		['b@example.com', 'active']
	]);
	const { parsed, diff } = plan(text, current, 'merge');
	assert.ok(parsed.warnings.some((w) => /Status column is ignored/.test(w)));
	assert.equal(diff.removed.length, 0);
	assert.equal(diff.changed.length, 0);
});

// ---------------------------------------------------------------------------
// R2: column semantics.
// ---------------------------------------------------------------------------

test('R2: an absent column leaves its field untouched and an empty cell clears it', () => {
	const current = [member('a@example.com', { name: 'Ada', city: 'Paris', bio: 'hi' })];
	const { diff } = plan(
		csvOf([
			['Email', 'City', 'Bio'],
			['a@example.com', '', 'hi']
		]),
		current,
		'merge'
	);
	assert.equal(diff.changed.length, 1);
	assert.deepEqual(diff.changed[0].changes, [{ key: 'city', before: 'Paris', after: null }]);
	// name is not in the file, so nothing about it is in the diff.
	assert.ok(!diff.changed[0].changes.some((c) => c.key === 'name'));
});

// ---------------------------------------------------------------------------
// R3, R4: addresses.
// ---------------------------------------------------------------------------

test('R3: a blank or invalid email is an error naming its rows, and no row is dropped', () => {
	const text =
		'Email,Bio\r\n' +
		'a@example.com,"two\nlines"\r\n' +
		',orphan\r\n' +
		'not-an-address,x\r\n' +
		'   ,y\r\n';
	const { parsed } = plan(text, roster(3), 'replace');
	const all = parsed.errors.join('\n');
	assert.match(all, /2 rows have no Email: row 3 \(file line 4\), row 5 \(file line 6\)/);
	assert.match(all, /Not an email address: row 4 \(file line 5\) \("not-an-address"\)/);
});

test('R3: an empty line is formatting only in a file of several columns', () => {
	const one = plan('Email\r\nm0@example.com\r\n\r\nm2@example.com\r\n', roster(3), 'replace');
	assert.match(one.parsed.errors.join('\n'), /1 row has no Email: row 3/);
	const quoted = plan('Email,Bio\r\nm0@example.com,x\r\n""\r\n', roster(1), 'replace');
	assert.match(quoted.parsed.errors.join('\n'), /row 3 has 1 cells/);
	const several = plan('Email,Bio\r\nm0@example.com,x\r\n\r\n', roster(1), 'merge');
	assert.deepEqual(several.parsed.errors, []);
	assert.equal(several.parsed.rows.length, 1);
});

test('R4: a duplicate email is an error naming both rows, whatever its case or spacing', () => {
	const text = csvOf([['Email'], ['a@example.com'], ['b@example.com'], [' A@EXAMPLE.com ']]);
	const { parsed } = plan(text, [], 'merge');
	assert.deepEqual(
		parsed.errors.filter((e) => /twice/.test(e)),
		['A@EXAMPLE.com appears twice, on row 2 and row 4. Keep one of them.']
	);
});

test('R15: email matching ignores case, and whitespace-only differences are unchanged', () => {
	const current = [member('ada@example.com', { name: 'Ada', city: 'Paris' })];
	const { diff } = plan(
		csvOf([
			['Email', 'Name', 'City'],
			['ADA@Example.COM', '  Ada ', 'Paris\t']
		]),
		current,
		'replace'
	);
	assert.deepEqual(diff.added, []);
	assert.deepEqual(diff.removed, []);
	assert.deepEqual(diff.changed, []);
	assert.equal(diff.unchanged, 1);
});

// ---------------------------------------------------------------------------
// R8, R9: removal guard rails.
// ---------------------------------------------------------------------------

function replaceKeeping(n: number, of: number) {
	const current = roster(of);
	const rows = [['Email'], ...current.slice(0, n).map((m) => [m.email])];
	return plan(csvOf(rows), current, 'replace').diff;
}

test('R8: a small removal proceeds without typing', () => {
	const diff = replaceKeeping(19, 20); // 1 of 20 = 5%
	const gate = removalGate(diff, 10);
	assert.equal(gate.kind, 'proceed');
	assert.ok(gateSatisfied(gate, null));
});

test('R8: past the configured proportion the count has to be typed', () => {
	const diff = replaceKeeping(16, 20); // 4 of 20 = 20%
	const gate = removalGate(diff, 10);
	assert.deepEqual(gate, { kind: 'typed', count: 4 });
	assert.equal(gateSatisfied(gate, null), false);
	assert.equal(gateSatisfied(gate, 'yes'), false);
	assert.equal(gateSatisfied(gate, '3'), false);
	assert.equal(gateSatisfied(gate, ' 4 '), true);
	// The proportion is the operator's: at 25% the same removal proceeds.
	assert.equal(removalGate(diff, 25).kind, 'proceed');
});

test('R8: past half the roster the browser refuses, with nothing to type, and names the script', () => {
	const diff = replaceKeeping(9, 20); // 11 of 20
	const gate = removalGate(diff, 50, 'example');
	assert.equal(gate.kind, 'refused');
	assert.ok(gate.kind === 'refused' && gate.reason === 'over-half');
	assert.ok(
		gate.kind === 'refused' &&
			/deploy\/run\.sh import-members example - --replace --apply --confirm-removals 11/.test(
				gate.message
			)
	);
	assert.equal(gateSatisfied(gate, '11'), false);
	// Exactly half is still the typed tier.
	assert.equal(removalGate(replaceKeeping(10, 20), 10).kind, 'typed');
});

test('R8: the proportion is configurable, defaults to 10, and refuses a value that could not matter', () => {
	assert.equal(confirmPercentFrom({}), 10);
	assert.equal(confirmPercentFrom({ IMPORT_CONFIRM_REMOVALS_PERCENT: '0' }), 0);
	assert.equal(confirmPercentFrom({ IMPORT_CONFIRM_REMOVALS_PERCENT: '25' }), 25);
	for (const bad of ['51', '-1', '10%', 'ten', '2.5']) {
		assert.throws(
			() => confirmPercentFrom({ IMPORT_CONFIRM_REMOVALS_PERCENT: bad }),
			/IMPORT_CONFIRM_REMOVALS_PERCENT/
		);
	}
});

test('R9: a file with no member rows against a populated group is refused in both modes', () => {
	for (const text of ['', 'Email\r\n', 'Email,City\r\n,\r\n\r\n']) {
		for (const mode of ['merge', 'replace'] as const) {
			const { diff } = plan(text, roster(3), mode);
			const gate = removalGate(diff, 50);
			assert.ok(
				gate.kind === 'refused' && gate.reason === 'empty-file',
				`${mode} ${JSON.stringify(text)}`
			);
		}
	}
	// An empty group importing an empty file is not that shape.
	assert.equal(removalGate(plan('Email\r\n', [], 'replace').diff, 10).kind, 'none');
});

// ---------------------------------------------------------------------------
// R10, R11: headings.
// ---------------------------------------------------------------------------

test('R10: an unknown column is a warning naming it, and its values are not written', () => {
	const current = [member('a@example.com', { name: 'Ada' }, { 'x.Notes': 'kept' })];
	const text = csvOf([
		['Email', 'Favourite Colur', 'Notes', 'x.Shoe'],
		['a@example.com', 'blue', 'changed', '9']
	]);
	const { parsed, diff } = plan(text, current, 'merge');
	assert.deepEqual(
		parsed.warnings.map((w) => w.split(' is not')[0]),
		['"Favourite Colur"', '"x.Shoe"']
	);
	assert.deepEqual(
		Object.keys(parsed.rows[0].values),
		['x.Notes'],
		'only a column the roster holds'
	);
	assert.deepEqual(diff.changed[0].changes, [{ key: 'x.Notes', before: 'kept', after: 'changed' }]);
});

test('R11: headings match labels ignoring case and surrounding spaces, with no legacy aliases', () => {
	const current = [member('a@example.com', { name: 'Ada', bio: 'x' })];
	const text = csvOf([
		['  EMAIL ', ' name', 'Biography', 'Bio (a few sentences)', ' PHONE'],
		['a@example.com', 'Ada', 'y', 'y', '555 0100']
	]);
	const { parsed } = plan(text, current, 'merge');
	assert.deepEqual(parsed.errors, []);
	// "Phone" is a private field's label, and matches like any other.
	assert.deepEqual(parsed.keys, ['name', 'phone']);
	// Neither a near miss nor a longer heading some other file used is "Bio".
	assert.ok(parsed.warnings.some((w) => w.startsWith('"Biography" is not')));
	assert.ok(parsed.warnings.some((w) => w.startsWith('"Bio (a few sentences)" is not')));
	// No Email heading at all is an error, not a guess.
	const noEmail = plan(
		csvOf([
			['E-mail address', 'City'],
			['a@example.com', 'Paris']
		]),
		current,
		'merge'
	).parsed;
	assert.deepEqual(noEmail.errors, [
		'The file has no "Email" column. Every row is matched to a member by it.'
	]);
});

test('R11: two headings that read as one field are an error naming both columns', () => {
	const { parsed } = plan(
		csvOf([
			['Email', 'City', 'city '],
			['a@example.com', 'a', 'b']
		]),
		[],
		'merge'
	);
	assert.deepEqual(parsed.errors, ['Columns 2 and 3 both read as "City". Delete one of them.']);
});

// ---------------------------------------------------------------------------
// R12: encodings and separators.
// ---------------------------------------------------------------------------

const SAMPLE = 'Email;City;Bio\r\nzoe@example.com;Köln, DE;"a;b\r\nc"\r\n';

test('R12: a semicolon file from European Excel is read with commas left inside cells', () => {
	assert.equal(sniffDelimiter(SAMPLE), ';');
	const { parsed } = plan(SAMPLE, [], 'merge');
	assert.deepEqual(parsed.errors, []);
	assert.deepEqual(parsed.rows[0].values, { city: 'Köln, DE', bio: 'a;b\r\nc' });
});

test('R12: tabs are sniffed, and a comma file stays comma', () => {
	assert.equal(sniffDelimiter('Email\tCity\r\na@example.com\tParis, FR\r\n'), '\t');
	assert.equal(sniffDelimiter('Email,City\r\na@example.com,"Paris; FR"\r\n'), ',');
	assert.equal(sniffDelimiter('Email\r\na@example.com\r\n'), ',');
	assert.equal(
		sniffDelimiter('"Odd, heading";Email\r\n'),
		';',
		'a delimiter inside quotes does not count'
	);
});

test('R12: UTF-8 with and without a BOM, and UTF-16 from "Unicode Text", decode to the same text', () => {
	const text = SAMPLE.replaceAll(';', '\t');
	const forms = [
		Buffer.from(text, 'utf8'),
		Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
		Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
		Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
		Buffer.from(text, 'utf16le')
	];
	for (const b of forms) assert.equal(decodeUpload(new Uint8Array(b)), text);
	const { parsed } = plan(decodeUpload(forms[2]), [], 'merge');
	assert.deepEqual(parsed.rows[0].values, {
		city: 'Köln, DE',
		bio: 'a\tb\r\nc'
	});
});

test('R12: a file in a legacy code page is refused rather than guessed at', () => {
	const latin1 = Buffer.from('Email,City\r\nzoe@example.com,K\xf6ln\r\n', 'latin1');
	assert.throws(() => decodeUpload(new Uint8Array(latin1)), /not UTF-8/);
});

test('R12: ragged rows are errors, and a trailing empty column is quiet', () => {
	const short = plan('Email,City,Bio\r\na@example.com,Paris\r\n', [], 'merge').parsed;
	assert.match(short.errors.join(), /row 2 has 2 cells but the heading row has 3/);
	const long = plan('Email,City\r\na@example.com,Paris,oops\r\n', [], 'merge').parsed;
	assert.match(long.errors.join(), /row 2 has more cells than there are headings/);
	const trailing = plan('Email,City,\r\na@example.com,Paris,\r\n', [], 'merge').parsed;
	assert.deepEqual(trailing.errors, []);
	assert.deepEqual(trailing.warnings, []);
});

test('R12: the parser is the shared csv-core one, and no CSV dependency was added', () => {
	const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
	assert.deepEqual(
		Object.keys(pkg.dependencies).filter((d) => /csv/i.test(d)),
		[]
	);
	const src = readFileSync(new URL('./import-core.ts', import.meta.url), 'utf8');
	assert.match(src, /from '\.\/csv-core'/);
});

// ---------------------------------------------------------------------------
// R13 (row half): the cap is enforced on rows, not only bytes.
// ---------------------------------------------------------------------------

test('R13: a file past the row cap is refused, and the default cap is set', () => {
	assert.equal(MAX_IMPORT_ROWS, 10_000);
	const rows = [['Email'], ...Array.from({ length: 6 }, (_, i) => [`m${i}@example.com`])];
	const { parsed } = plan(csvOf(rows), [], 'merge');
	assert.deepEqual(parsed.errors, []);
	const capped = parseImport(csvOf(rows), { mode: 'merge', maxRows: 5 });
	assert.match(capped.errors.join(), /The file has 6 rows; the import takes at most 5/);
});

// ---------------------------------------------------------------------------
// R7 (pure half): the digest is the diff.
// ---------------------------------------------------------------------------

test('R7: the digest moves when the diff does and holds when it does not', () => {
	const current = [member('a@example.com', { city: 'Paris' }), member('b@example.com')];
	const text = csvOf([
		['Email', 'City'],
		['a@example.com', 'Rome']
	]);
	const one = diffDigest(plan(text, current, 'merge').diff);
	assert.equal(diffDigest(plan(text, structuredClone(current), 'merge').diff), one);
	// Somebody saved a.city meanwhile: same file, different change.
	const edited = [member('a@example.com', { city: 'Oslo' }), member('b@example.com')];
	assert.notEqual(diffDigest(plan(text, edited, 'merge').diff), one);
	// Same file, other mode: the removal of b is part of what is confirmed.
	assert.notEqual(diffDigest(plan(text, current, 'replace').diff), one);
});

test('R7: the digest binds the membership state each edit is explained against', () => {
	const text = csvOf([
		['Email', 'Bio'],
		['a@example.com', 'new']
	]);
	const removedA = [
		member('a@example.com', { bio: 'old' }, {}, 'removed'),
		member('b@example.com')
	];
	const swapped = [
		member('a@example.com', { bio: 'old' }),
		member('b@example.com', {}, {}, 'removed')
	];
	const one = plan(text, removedA, 'merge').diff;
	const two = plan(text, swapped, 'merge').diff;
	assert.equal(one.active, two.active);
	assert.notEqual(previewView(one).changed[0].inactive, previewView(two).changed[0].inactive);
	assert.notEqual(diffDigest(one), diffDigest(two));
	// A member the file does not touch changing state is not part of what was read.
	const peerEdited = [
		member('a@example.com', { bio: 'old' }, {}, 'removed'),
		member('b@example.com', { city: 'Oslo' })
	];
	assert.equal(diffDigest(plan(text, peerEdited, 'merge').diff), diffDigest(one));
});

test('replace: a Status cell marks a removal or a return, and a removed status for a stranger is an error', () => {
	const current = [
		member('a@example.com'),
		member('b@example.com', {}, {}, 'removed'),
		member('c@example.com')
	];
	const text = csvOf([
		['Email', 'Status'],
		['a@example.com', 'Removed'],
		['b@example.com', 'active'],
		['c@example.com', 'active']
	]);
	const { diff } = plan(text, current, 'replace');
	assert.deepEqual(
		diff.removed.map((r) => [r.email, r.via]),
		[['a@example.com', 'status']]
	);
	assert.deepEqual(
		diff.changed.map((c) => [c.email, c.changes]),
		[['b@example.com', [{ key: 'status', before: 'removed', after: 'active' }]]]
	);
	const stranger = plan(
		csvOf([
			['Email', 'Status'],
			['new@example.com', 'removed']
		]),
		current,
		'replace'
	).diff;
	assert.match(stranger.errors.join(), /new@example.com is not in the directory/);
});

test('R7: a structured value compares the same whatever its key order, with exact digits', () => {
	const file = parseJsonExact('{"z":{"y":1,"x":[{"d":1,"c":2}]},"a":9007199254740993}');
	const stored = parseJsonExact('{"a":9007199254740993,"z":{"x":[{"c":2,"d":1}],"y":1}}');
	assert.equal(canonical(file), canonical(stored));
	assert.match(canonical(file), /9007199254740993/);
	assert.notEqual(canonical(parseJsonExact('[1,2]')), canonical(parseJsonExact('[2,1]')));
});

test('R7: a value of another type is a change and moves the digest; whitespace and empty are not', () => {
	const bio = (v: unknown) => [member('a@example.com', v === undefined ? {} : { bio: v })];
	const file = csvOf([
		['Email', 'Bio'],
		['a@example.com', 'replacement']
	]);
	const digest = (v: unknown) => diffDigest(plan(file, bio(v), 'merge').diff);
	const pairs: [unknown, unknown][] = [
		['true', true],
		['42', parseJsonExact('42')],
		['{"a":1}', parseJsonExact('{"a":1}')],
		['[1]', parseJsonExact('[1]')],
		['null', ''],
		['json:true', true]
	];
	for (const [text, typed] of pairs) {
		assert.notEqual(comparable(text), comparable(typed), String(text));
		assert.notEqual(digest(text), digest(typed), String(text));
	}
	assert.equal(digest('  kept  '), digest('kept'));
	assert.equal(digest(''), digest(undefined));
	assert.equal(digest('   '), digest(null));
	assert.equal(comparable('   '), '');
	assert.equal(canonical('private'), 'private');

	// The same distinction holds when the file carries the typed value.
	const typedCell = csvOf([
		['Email', 'Bio'],
		['a@example.com', 'json:true']
	]);
	assert.equal(plan(typedCell, bio('true'), 'merge').diff.changed.length, 1);
	assert.equal(plan(typedCell, bio(true), 'merge').diff.unchanged, 1);
});

test('a plan digest changes when the field definitions change, so a saved plan drifts', () => {
	const diff = diffImport(parseImport('Email\nada@example.org\n', { mode: 'merge' }), [], 'merge');
	const links = DEFAULT_FIELD_SCHEMA.find((f) => f.type === 'links')!;
	const renamed = DEFAULT_FIELD_SCHEMA.map((f) => (f === links ? { ...f, key: 'otherLinks' } : f));
	const retyped = DEFAULT_FIELD_SCHEMA.map((f) => (f === links ? { ...f, type: 'longtext' } : f));
	const fewer = DEFAULT_FIELD_SCHEMA.map((f) => (f === links ? { ...f, sites: ['github'] } : f));
	const base = diffDigest(diff, DEFAULT_FIELD_SCHEMA);
	assert.equal(diffDigest(diff), base);
	for (const schema of [renamed, retyped, fewer]) {
		assert.notEqual(diffDigest(diff, schema as FieldDef[]), base);
	}
});
