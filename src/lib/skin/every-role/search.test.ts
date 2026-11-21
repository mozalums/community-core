import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// What searchMembers does with the roles the default skin leaves out: the
// tenure span a year filters on, the handle the trigram reads, and a checkbox
// matched by its label. The word-at-a-time search itself is
// src/lib/server/members.test.ts. Application modules are imported dynamically
// because a static import would bind the field schema before the line above
// runs.

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
let rowsFor: (call: number) => unknown[] = () => [];

mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (sql: string, params: unknown[]) => {
			calls.push({ sql, params });
			return { rows: rowsFor(calls.length - 1) };
		},
		withTransaction: async () => assert.fail('no transaction expected here')
	}
});

mock.module('$lib/server/avatars', {
	namedExports: {
		emailMd5: (e: string) => `md5:${e}`,
		ensureAvatarRows: async () => {}
	}
});

const { searchMembers } = await import('$lib/server/members');
const { fieldByRole } = await import('$lib/server/field-schema');

// The key bound to the placeholder a clause reads `data->>` through, so a test
// can say which field a clause reads without the SQL naming one.
function boundKeys(c: Call, pattern: RegExp): unknown[] {
	return [...flat(c.sql).matchAll(pattern)].map((m) => c.params[Number(m[1]) - 1]);
}
const tenureBounds = (c: Call) => ({
	start: boundKeys(c, /\(member\.data->>\$(\d+)\)::int <= \$\d+/g),
	end: boundKeys(c, /\(member\.data->>\$(\d+)\)::int >= \$\d+/g)
});

const flat = (s: string) => s.replace(/\s+/g, ' ');
const termBlocks = (sql: string) =>
	(sql.match(/websearch_to_tsquery\('simple', search_unaccent\(\$\d+\)\)/g) ?? []).length;
// The checkbox keys bound beside their labels, once per place a word's
// checkboxes are read: matching, ranking and naming.
const checkboxKeys = (c: Call) =>
	boundKeys(c, /unnest\(\$(\d+)::text\[\], \$\d+::text\[\]\)(?: WITH ORDINALITY)? AS b/g);
// Every place a word reads a checkbox, and whether that read requires the
// box's folded label to hold the word. The key list is every visible
// checkbox, so this gate is what keeps a word from admitting, ranking or
// naming a box its label does not hold.
const checkboxReads = (c: Call) =>
	[...flat(c.sql).matchAll(/AS b\(k, label(?:, n)?\) WHERE (.{0,200})/g)].map((m) =>
		/^lower\(btrim\(coalesce\(member\.data->>b\.k, ''\)\)\) IN \([^)]*\) AND \(?search_unaccent\(lower\(normalize\(b\.label, NFC\)\)\) ILIKE /.test(
			m[1]
		)
	);
const VISIBLE_BOXES = ['staff', 'volunteer', 'publicProfile'];
// The key the handle trigram is bound to, wherever it is read.
const handleTrigram = (c: Call) => [
	...new Set(boundKeys(c, /l\.k = \$(\d+) AND coalesce\(member\.data->>l\.k, ''\) %/g))
];
// A word block after the first, joined by OR: each opens with its whole-word
// test on the name column.
const orJoined = (sql: string) =>
	/\) OR \(\(NOT querytree\(websearch_to_tsquery\('simple', search_unaccent\(\$\d+\)\)\) = 'T' AND \(\(visible_tsv @@ websearch_to_tsquery\('simple', search_unaccent\(\$\d+\)\) AND tsvector_to_array\(to_tsvector\('simple', search_unaccent\(lower\(normalize\(coalesce\(name, ''\), NFC\)\)\)\)\)/.test(
		flat(sql).slice(0, flat(sql).lastIndexOf('ORDER BY'))
	);

function reset(rows: (call: number) => unknown[] = () => []) {
	calls = [];
	rowsFor = rows;
}

test('a year stays an AND filter, and alone it does not trigger the fallback', async () => {
	reset(() => []);
	await searchMembers('g', { q: '2015' });
	assert.equal(calls.length, 1, 'a bare year is a filter, not a term to loosen');
	assert.deepEqual(
		tenureBounds(calls[0]),
		{ start: [fieldByRole('tenureStart').key], end: [fieldByRole('tenureEnd').key] },
		'the tenure span reads the fields holding the tenure roles'
	);
	assert.equal(termBlocks(calls[0].sql), 0, 'no free-text block for a bare year');
	assert.ok(calls[0].params.includes(2015));
});

test('a year AND-s with the words, and is kept when they are loosened', async () => {
	reset((n) => (n === 0 ? [] : [{ id: 'm3', group_id: 'g', email: 'a@b.c', data: {} }]));
	await searchMembers('g', { q: '2015 london chess' });

	assert.equal(calls.length, 2);
	for (const c of calls) {
		assert.deepEqual(
			tenureBounds(c).start,
			[fieldByRole('tenureStart').key],
			'the year survives both passes'
		);
		assert.ok(c.params.includes(2015));
	}
	assert.ok(orJoined(calls[1].sql), 'only the words loosen');
});

test('search finds fields by role and filters no key by a deny-list', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'volun 2015' });
	const c = calls[0];
	const sql = flat(c.sql);

	assert.doesNotMatch(sql, /->>\s*'/, 'a clause reads data by a literal key');
	assert.doesNotMatch(sql, /!~\s*'[a-z|]+'/, 'a key is still filtered by a regex');
	assert.doesNotMatch(sql, /postal|whatsapp|address/i);
	assert.doesNotMatch(sql, /private_data/, 'search reached the private column');
	assert.deepEqual(
		handleTrigram(c),
		[],
		'a hit on the exact pass never reached the handle trigram'
	);
	assert.ok(checkboxKeys(c).length > 0, 'the checkbox clause moved; point this test at it');
	for (const keys of checkboxKeys(c)) assert.deepEqual(keys, VISIBLE_BOXES);
	assert.deepEqual(
		checkboxReads(c),
		checkboxKeys(c).map(() => true),
		'the word names a checkbox only by its label'
	);
});

test('the handle trigram joins only the pass after the exact one found nobody', async () => {
	reset((n) => (n === 0 ? [] : [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]));
	const { fuzzy } = await searchMembers('g', { q: 'carl' });
	assert.equal(calls.length, 2);
	assert.deepEqual(handleTrigram(calls[0]), []);
	assert.deepEqual(handleTrigram(calls[1]), [fieldByRole('handle').key]);
	assert.equal(fuzzy, true);
});

test('a word naming no checkbox reads every visible box only through its label', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'postal' });
	assert.ok(checkboxKeys(calls[0]).length > 0, 'the checkbox clause moved; point this test at it');
	for (const keys of checkboxKeys(calls[0])) assert.deepEqual(keys, VISIBLE_BOXES);
	assert.deepEqual(
		checkboxReads(calls[0]),
		checkboxKeys(calls[0]).map(() => true)
	);
});
