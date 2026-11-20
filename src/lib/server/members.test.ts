import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// What these pin down is the shape of the WHERE clause, because that is where
// the bug lived: the whole query string went to every clause at once, the
// clauses were OR'd, and `similarity('London', 'london chess')` sailed past
// the 0.3 trigram threshold. Every London member came back as a chess match.
// A word at a time, AND'd, is the fix — and the fallback is what keeps AND
// from turning "no member matches all of this" into a dead end.
//
// These run on the default skin, which has no tenure, handle or checkbox
// field. The year filter, the handle trigram and the checkbox-by-label match
// are in src/lib/skin/every-role/search.test.ts.
//
// `query` is mocked rather than pointed at a database: postgres.ts reaches
// `$env/dynamic/private` and cannot load under the test runner, and the SQL
// text is the thing under test anyway.

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

const { searchMembers } = await import('./members');

// The key bound to the placeholder a clause reads `data->>` through, so a test
// can say which field a clause reads without the SQL naming one.
function boundKeys(c: Call, pattern: RegExp): unknown[] {
	return [...flat(c.sql).matchAll(pattern)].map((m) => c.params[Number(m[1]) - 1]);
}

const flat = (s: string) => s.replace(/\s+/g, ' ');
const termBlocks = (sql: string) =>
	(sql.match(/websearch_to_tsquery\('simple', \$\d+\)/g) ?? []).length;

function reset(rows: (call: number) => unknown[] = () => []) {
	calls = [];
	rowsFor = rows;
}

test('each word gets its own block and they are AND-ed', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'london chess' });

	assert.equal(calls.length, 1, 'a hit needs no second pass');
	const sql = flat(calls[0].sql);
	assert.match(sql, /\) AND \( visible_tsv/, 'blocks joined with AND');
	assert.ok(calls[0].params.includes('london'), 'london is its own parameter');
	assert.ok(calls[0].params.includes('chess'), 'chess is its own parameter');
	// One block per word, plus the ranking expression over the whole query.
	assert.equal(termBlocks(calls[0].sql), 3);
});

test('no member matching every word falls back to matching any', async () => {
	reset((n) => (n === 0 ? [] : [{ id: 'm2', group_id: 'g', email: 'a@b.c', data: {} }]));
	const { members, relaxed } = await searchMembers('g', { q: 'berlin popcorn' });

	assert.equal(calls.length, 2, 'the empty AND pass is retried');
	assert.match(flat(calls[0].sql), /\) AND \( visible_tsv/);
	assert.match(flat(calls[1].sql), /\) OR \( visible_tsv/, 'the retry joins with OR');
	assert.equal(members.length, 1);
	assert.equal(relaxed, true, 'the page has to be able to say so');
});

test('a fallback that also finds nothing is not called relaxed', async () => {
	reset(() => []);
	const { members, relaxed } = await searchMembers('g', { q: 'zzz qqq' });
	assert.equal(members.length, 0);
	assert.equal(relaxed, false, 'nothing was loosened for the visitor to be told about');
});

test('one word is never retried — AND and OR are the same query', async () => {
	reset(() => []);
	const { relaxed } = await searchMembers('g', { q: 'chess' });
	assert.equal(calls.length, 1);
	assert.equal(relaxed, false);
});

test('with no tenure fields a year is a word like any other', async () => {
	reset((n) => (n === 0 ? [] : [{ id: 'm3', group_id: 'g', email: 'a@b.c', data: {} }]));
	const { relaxed } = await searchMembers('g', { q: '2015 london' });

	assert.equal(calls.length, 2, 'the year loosens with the other word');
	assert.equal(relaxed, true);
	for (const c of calls) {
		assert.doesNotMatch(flat(c.sql), /::int/, 'a tenure span was filtered on');
		assert.ok(c.params.includes('2015'), 'the year is bound as text');
		assert.ok(!c.params.includes(2015));
	}
	// One block per word, plus the ranking expression over the whole query.
	assert.equal(termBlocks(calls[0].sql), 3);
});

test('city stays a separate ILIKE filter', async () => {
	reset(() => []);
	await searchMembers('g', { city: 'Berlin' });
	assert.equal(calls.length, 1);
	assert.match(flat(calls[0].sql), /city ILIKE \$\d+/);
	assert.ok(calls[0].params.includes('%Berlin%'));
});

test('with no handle or checkbox field the search binds no field key and reads no private data', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'phone' });
	const c = calls[0];
	const sql = flat(c.sql);

	assert.doesNotMatch(sql, /->>\s*'/, 'a clause reads data by a literal key');
	assert.doesNotMatch(sql, /!~\s*'[a-z|]+'/, 'a key is still filtered by a regex');
	assert.doesNotMatch(sql, /private_data/, 'search reached the private column');
	assert.deepEqual(boundKeys(c, /coalesce\(member\.data->>\$(\d+), ''\) %/g), []);
	// "phone" is the label of a private field, which is no checkbox to match.
	assert.deepEqual(boundKeys(c, /unnest\(\$(\d+)::text\[\]\)/g), [[]]);
});

test('data values are matched under the members-visible keys alone', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: '7791' });
	const allowed = boundKeys(calls[0], /\.k = ANY\(\$(\d+)::text\[\]\)/g);
	// The whole-word vector and the substring clause, both under one list.
	assert.equal(allowed.length, 2, 'a data clause reads keys no allowlist names');
	for (const keys of allowed) assert.deepEqual(keys, ['name', 'country', 'city', 'bio']);
	assert.doesNotMatch(flat(calls[0].sql), /\bsearch_tsv\b/, 'the stored vector reads every key');
});

test('% _ and \\ in a word reach every ILIKE as literals', async () => {
	reset(() => []);
	await searchMembers('g', { q: '50%_off\\', city: 'a_b%' });
	const c = calls[0];
	assert.ok(c.params.includes('%50\\%\\_off\\\\%'), 'the word reached ILIKE unescaped');
	assert.ok(c.params.includes('%a\\_b\\%%'), 'the city reached ILIKE unescaped');
	const ilikes = flat(c.sql).match(/ILIKE \$\d+( ESCAPE '\\')?/g) ?? [];
	// name, city, the data values and the city filter. The default skin feeds
	// no field into linkedin, so nothing the profile shows lives there.
	assert.equal(ilikes.length, 4);
	for (const m of ilikes) assert.match(m, /ESCAPE '\\'$/, `${m} takes the default escape`);
});

test('a word naming no checkbox binds an empty key list rather than every key', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'postal' });
	assert.deepEqual(boundKeys(calls[0], /unnest\(\$(\d+)::text\[\]\)/g), [[]]);
});
