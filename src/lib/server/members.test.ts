import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, mock } from 'node:test';

// What these pin down is the shape of the WHERE clause, because that is where
// the bug lived: the whole query string went to every clause at once, the
// clauses were OR'd, and `similarity('London', 'london chess')` sailed past
// the 0.3 trigram threshold. Every London member came back as a chess match.
// A word at a time, AND'd, is the fix — and the fallback is what keeps AND
// from turning "no member matches all of this" into a dead end. Trigram itself
// then left the first pass: `similarity('carlo', 'cars')` clears 0.3 too, so
// it runs only once the exact passes found nobody.
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

const { searchMembers, searchTokens } = await import('./members');

test('a query is NFKC-folded, lowercased and split, and wordless tokens drop', () => {
	assert.deepEqual(searchTokens('José 🚗'), ['josé']);
	assert.deepEqual(searchTokens('ＣＡＦＥ　ﬁsh'), ['cafe', 'fish']);
	assert.deepEqual(searchTokens('café'), ['café']);
	assert.deepEqual(searchTokens('🚗 — !! 🎉'), []);
	assert.deepEqual(searchTokens('🚗cars -x 2015'), ['🚗cars', '-x', '2015']);
	assert.deepEqual(searchTokens(undefined), []);
});

test('a query with no searchable words sends no search', async () => {
	reset(() => []);
	await searchMembers('g', { q: '🚗 🎉' });
	assert.equal(calls.length, 1);
	assert.doesNotMatch(flat(calls[0].sql), /visible_tsv/);
});

// The key bound to the placeholder a clause reads `data->>` through, so a test
// can say which field a clause reads without the SQL naming one.
function boundKeys(c: Call, pattern: RegExp): unknown[] {
	return [...flat(c.sql).matchAll(pattern)].map((m) => c.params[Number(m[1]) - 1]);
}
// The checkbox keys bound beside their labels, once per place a word's
// checkboxes are read: matching, ranking and naming.
const checkboxKeys = (c: Call) =>
	boundKeys(c, /unnest\(\$(\d+)::text\[\], \$\d+::text\[\]\)(?: WITH ORDINALITY)? AS b/g);

const flat = (s: string) => s.replace(/\s+/g, ' ');
// The WHERE clause alone: the matched-field list before it and the ORDER BY
// after it repeat the same per-word expressions.
const whereOf = (sql: string) => {
	const s = flat(sql);
	return s.slice(s.indexOf(' WHERE group_id'), s.lastIndexOf('ORDER BY'));
};
// Each word's block opens with its whole-word test: the word against the
// member's visible vector, then the name column's share of its lexemes.
const WORD = String.raw`\(NOT querytree\(websearch_to_tsquery\('simple', search_unaccent\(\$\d+\)\)\) = 'T' AND \(\(visible_tsv @@ websearch_to_tsquery\('simple', search_unaccent\(\$\d+\)\) AND tsvector_to_array\(to_tsvector\('simple', search_unaccent\(lower\(normalize\(coalesce\(name, ''\), NFC\)\)\)\)\)`;
const termBlocks = (sql: string) => (whereOf(sql).match(new RegExp(WORD, 'g')) ?? []).length;
const andJoined = (sql: string) => new RegExp(`= 'T'\\) AND \\(\\(${WORD}`).test(whereOf(sql));
const orJoined = (sql: string) => new RegExp(`\\) OR \\(${WORD}`).test(whereOf(sql));
const trigram = (sql: string) => / % \$\d+/.test(flat(sql));

function reset(rows: (call: number) => unknown[] = () => []) {
	calls = [];
	rowsFor = rows;
}

test('each word gets its own block and they are AND-ed', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'london chess' });

	assert.equal(calls.length, 1, 'a hit needs no second pass');
	assert.ok(andJoined(calls[0].sql), 'blocks joined with AND');
	assert.ok(!orJoined(calls[0].sql), 'blocks joined with OR');
	assert.ok(calls[0].params.includes('london'), 'london is its own parameter');
	assert.ok(calls[0].params.includes('chess'), 'chess is its own parameter');
	assert.equal(termBlocks(calls[0].sql), 2, 'one block per word');
	assert.ok(calls[0].params.includes('london chess'), 'ts_rank reads the whole query');
	assert.equal(trigram(calls[0].sql), false, 'the exact pass forgives no typo');
});

test('no member matching every word falls back to matching any', async () => {
	reset((n) => (n === 0 ? [] : [{ id: 'm2', group_id: 'g', email: 'a@b.c', data: {} }]));
	const { members, relaxed } = await searchMembers('g', { q: 'berlin popcorn' });

	assert.equal(calls.length, 2, 'the empty AND pass is retried');
	assert.ok(andJoined(calls[0].sql));
	assert.ok(orJoined(calls[1].sql), 'the retry joins with OR');
	assert.ok(!andJoined(calls[1].sql), 'the retry still ANDs the blocks');
	assert.equal(members.length, 1);
	assert.equal(relaxed, true, 'the page has to be able to say so');
});

test('a fallback that also finds nothing is not called relaxed or fuzzy', async () => {
	reset(() => []);
	const { members, relaxed, fuzzy } = await searchMembers('g', { q: 'zzz qqq' });
	assert.equal(members.length, 0);
	assert.equal(relaxed, false, 'nothing was loosened for the visitor to be told about');
	assert.equal(fuzzy, false);
	assert.deepEqual(
		calls.map((c) => [andJoined(c.sql), trigram(c.sql)]),
		[
			[true, false],
			[false, false],
			[true, true],
			[false, true]
		],
		'exact AND, exact OR, then the same two with trigram added'
	);
});

test('one word is never retried as OR — AND and OR are the same query', async () => {
	reset(() => []);
	const { relaxed, fuzzy } = await searchMembers('g', { q: 'chess' });
	assert.equal(calls.length, 2, 'the exact pass, then the trigram pass');
	assert.deepEqual(
		calls.map((c) => trigram(c.sql)),
		[false, true]
	);
	assert.equal(relaxed, false);
	assert.equal(fuzzy, false);
});

test('trigram runs only after the exact pass finds nobody, and the result says so', async () => {
	reset((n) => (n === 0 ? [] : [{ id: 'm4', group_id: 'g', email: 'a@b.c', data: {} }]));
	const { members, fuzzy, relaxed } = await searchMembers('g', { q: 'Frinoli' });
	assert.equal(calls.length, 2);
	assert.equal(trigram(calls[0].sql), false);
	assert.match(flat(calls[1].sql), /\(name % \$\d+ OR city % \$\d+/);
	assert.equal(members.length, 1);
	assert.equal(fuzzy, true);
	assert.equal(relaxed, false);
});

test('a hit names the matched fields, grouped by label, from the per-word lists', async () => {
	reset(() => [
		{ id: 'm5', group_id: 'g', email: 'a@b.c', data: {}, matched: [['Bio'], ['City', 'Bio']] }
	]);
	const { members } = await searchMembers('g', { q: 'cars lisbon' });
	assert.deepEqual(members[0].matched, [
		{ label: 'Bio', words: ['cars', 'lisbon'] },
		{ label: 'City', words: ['lisbon'] }
	]);
	// A key that feeds a column carries the column's label, so a match on it
	// reads as that column and groups with it rather than naming the key.
	const sql = flat(calls[0].sql);
	const [, keys, labels] =
		sql.match(/unnest\(\$(\d+)::text\[\], \$(\d+)::text\[\]\) WITH ORDINALITY AS l/) ?? [];
	assert.deepEqual(calls[0].params[Number(keys) - 1], ['name', 'country', 'city', 'bio']);
	assert.deepEqual(calls[0].params[Number(labels) - 1], ['Name', 'Country', 'City', 'Bio']);
});

test('ranking puts a whole-word name match, then any whole word, then a substring, before ts_rank', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'stone' });
	const order = flat(calls[0].sql).slice(flat(calls[0].sql).lastIndexOf('ORDER BY'));
	const at = (re: RegExp) => order.search(re);
	const steps = [
		/normalize\(coalesce\(name, ''\), NFC\)\)\)\)\) &&/,
		/member_search_values\(jsonb_build_object/,
		/normalize\(name, NFC\)\)\) ILIKE/,
		/ts_rank\(/,
		/lower\(name\)/
	].map(at);
	assert.ok(
		steps.every((i) => i > 0),
		`an ordering step is missing: ${steps}`
	);
	assert.deepEqual(
		[...steps].sort((a, b) => a - b),
		steps,
		'ordering steps out of order'
	);
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
	assert.equal(termBlocks(calls[0].sql), 2, 'one block per word');
});

test('city stays a separate ILIKE filter', async () => {
	reset(() => []);
	await searchMembers('g', { city: 'Berlin' });
	assert.equal(calls.length, 1);
	assert.match(
		flat(calls[0].sql),
		/normalize\(city, NFC\)\)\) ILIKE \('%' \|\| regexp_replace\(search_unaccent\(\$\d+\)/
	);
	assert.ok(calls[0].params.includes('Berlin'));
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
	assert.ok(checkboxKeys(c).length > 0, 'the checkbox clause moved; point this test at it');
	for (const keys of checkboxKeys(c)) assert.deepEqual(keys, []);
});

test('data values are matched under the members-visible keys alone', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: '7791' });
	const sql = flat(calls[0].sql);
	const allowed = [
		...boundKeys(calls[0], /WHERE e\.k = ANY\(\$(\d+)::text\[\]\)/g),
		...boundKeys(calls[0], /unnest\(\$(\d+)::text\[\]\) AS l\(k\)/g),
		...boundKeys(calls[0], /unnest\(\$(\d+)::text\[\], \$\d+::text\[\]\) WITH ORDINALITY AS l/g)
	];
	// Every `l.k` a data clause reads comes from one of these lists: the rank
	// vector, the whole-word, substring and typo clauses (matching and
	// ranking), and the matched-field labels.
	const lScopes = (sql.match(/ AS l\(k[,)]/g) ?? []).length;
	assert.equal(allowed.length, lScopes + 1, 'a data clause reads keys no allowlist names');
	assert.ok(lScopes >= 4, 'the per-key clauses moved; point this test at them');
	for (const keys of allowed) assert.deepEqual(keys, ['name', 'country', 'city', 'bio']);
	// The name tier narrows a listed scope to the name's parts; it never widens it.
	const nameParts = boundKeys(calls[0], /l\.k = ANY\(\$(\d+)::text\[\]\)/g);
	assert.ok(nameParts.length > 0, 'the name tier moved; point this test at it');
	for (const keys of nameParts)
		for (const k of keys as string[]) assert.ok(['name', 'country', 'city', 'bio'].includes(k), k);
	// Which visible keys hold checkbox markers narrows how a value tokenizes;
	// it never names a key the scope lacks.
	const markerKeys = boundKeys(calls[0], /CASE WHEN e\.k = ANY\(\$(\d+)::text\[\]\)/g);
	assert.equal(markerKeys.length, 1, 'the checkbox marker list moved; point this test at it');
	for (const keys of markerKeys)
		for (const k of keys as string[]) assert.ok(['name', 'country', 'city', 'bio'].includes(k), k);
	const dataReads = sql.match(/member\.data->>?[\w.$]+/g) ?? [];
	for (const r of dataReads)
		assert.match(r, /^member\.data->>?[lb]\.k$/, `${r} reads an unlisted key`);
	assert.doesNotMatch(flat(calls[0].sql), /\bsearch_tsv\b/, 'the stored vector reads every key');
});

test('% _ and \\ in a word reach every ILIKE as literals', async () => {
	reset(() => []);
	await searchMembers('g', { q: '50%_off\\', city: 'a_b%' });
	const c = calls[0];
	// The pattern is built in SQL, after unaccent, which can itself produce a
	// wildcard or the escape, so the escape reads search_unaccent's output.
	// member-search-privacy.pg.test.ts runs it against a real database.
	const ESCAPED = String.raw`('%' || regexp_replace(search_unaccent($`;
	const TAIL = String.raw`), '([\\%_])', '\\\1', 'g') || '%') ESCAPE '\'`;
	const ilikes = [...flat(c.sql).matchAll(/ILIKE (\S+)/g)];
	// name, city, the data values and the checkbox labels, each in the match,
	// the ranking and the matched-field labels, and the city filter. The
	// default skin feeds no field into linkedin, so nothing the profile shows
	// lives there.
	assert.equal(ilikes.length, 15);
	const sql = flat(c.sql);
	for (const m of ilikes) {
		const rest = sql.slice(m.index! + 'ILIKE '.length);
		assert.ok(rest.startsWith(ESCAPED), `${rest.slice(0, 60)} builds no escaped pattern`);
		const n = Number(/^\d+/.exec(rest.slice(ESCAPED.length))![0]);
		assert.ok(
			rest.slice(ESCAPED.length + String(n).length).startsWith(TAIL),
			`${rest.slice(0, 120)} escapes differently or takes another escape`
		);
		assert.ok(
			['50%_off\\', 'a_b%'].includes(c.params[n - 1] as string),
			`ILIKE $${n} binds ${String(c.params[n - 1])}`
		);
	}
});

test('a word naming no checkbox binds an empty key list rather than every key', async () => {
	reset(() => [{ id: 'm1', group_id: 'g', email: 'a@b.c', data: {} }]);
	await searchMembers('g', { q: 'postal' });
	assert.ok(checkboxKeys(calls[0]).length > 0, 'the checkbox clause moved; point this test at it');
	for (const keys of checkboxKeys(calls[0])) assert.deepEqual(keys, []);
});

test('the comment above the tenure clause states the open-bound rule', () => {
	const lines = readFileSync(new URL('./members.ts', import.meta.url), 'utf8').split('\n');
	const clause = lines.findIndex((l) =>
		l.includes('if (years.length && tenureStart && tenureEnd)')
	);
	assert.ok(clause > 0, 'the tenure clause moved; point this test at it');
	const comment: string[] = [];
	for (let i = clause - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) {
		comment.unshift(lines[i].replace(/^\s*\/\/\s?/, ''));
	}
	const text = comment.join(' ').replace(/\s+/g, ' ');
	assert.match(
		text,
		/missing, empty or not four digits is open/,
		'a missing or invalid bound is open'
	);
	assert.match(
		text,
		/at least one bound must be a valid year/,
		'at least one valid bound is required'
	);
});
