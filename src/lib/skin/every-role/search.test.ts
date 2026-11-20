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
	(sql.match(/websearch_to_tsquery\('simple', \$\d+\)/g) ?? []).length;

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
	assert.match(flat(calls[1].sql), /\) OR \( visible_tsv/, 'only the words loosen');
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
	assert.deepEqual(boundKeys(c, /coalesce\(member\.data->>\$(\d+), ''\) %/g), [
		fieldByRole('handle').key
	]);
	const checkboxKeys = boundKeys(c, /unnest\(\$(\d+)::text\[\]\)/g);
	assert.deepEqual(
		checkboxKeys,
		[['volunteer']],
		'the word names the Volunteer checkbox by its label'
	);
});

test('a word naming no checkbox binds an empty key list rather than every key', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'postal' });
	assert.deepEqual(boundKeys(calls[0], /unnest\(\$(\d+)::text\[\]\)/g), [[]]);
});
