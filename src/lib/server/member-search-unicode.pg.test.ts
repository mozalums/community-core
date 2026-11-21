import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { UNICODE_SEARCH_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(UNICODE_SEARCH_FIELDS) });

// Emoji, accents and Unicode normal forms in a query and in stored values,
// against real rows through the page loader a non-admin member reaches.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'b32-search-unicode';
const GROUP = { id: '', slug: SLUG, name: 'B32 search unicode', landingMd: null, status: 'active' };

mock.module('$lib/server/postgres', {
	namedExports: {
		query: (text: string, values?: unknown[]) => pool!.query(text, values),
		withTransaction: async () => assert.fail('search writes nothing')
	}
});
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/avatars', {
	namedExports: {
		emailMd5: (s: string) => s,
		ensureAvatarRows: async () => new Map(),
		avatarIdsByEmailMd5: async () => new Map(),
		getAvatarByEmail: async () => null,
		recordGravatar: async () => {}
	}
});

const { migrate } = await import('./migrations');
const { load } = await import('../../routes/group/[slug]/members/+page.server');

type Page = {
	members: { name: string | null; matched: { label: string; words: string[] }[] }[];
	filtered: boolean;
	relaxed: boolean;
	fuzzy: boolean;
	unsearchable: boolean;
};

async function directory(q: string): Promise<Page> {
	return (await load({
		params: { slug: SLUG },
		url: new URL(`https://example.org/group/${SLUG}/members?q=${encodeURIComponent(q)}`),
		parent: async () => ({}),
		locals: { user: { id: 'u1', email: 'r@example.org', subject: 'email:r@example.org' } }
	} as unknown as Parameters<typeof load>[0])) as Page;
}
const names = (p: Page) => p.members.map((m) => m.name ?? '').sort();
// The typo pass forgives a missing accent too ("cafe" against "Café" clears
// the trigram threshold), so a match only counts when the exact pass made it.
async function exact(q: string): Promise<string[]> {
	const page = await directory(q);
	assert.equal(page.fuzzy, false, `${q} was answered by the typo pass`);
	assert.equal(page.relaxed, false, `${q} was answered by the any-word fallback`);
	return names(page);
}

// Stored decomposed, as an older import could write it. unaccent strips the
// combining marks NFD Latin leaves behind, so only a script whose NFD form is
// not marks (Hangul splits into jamo) shows the stored value read in NFC.
const HANGUL_NFD = '김한결'.normalize('NFD');

const MEMBERS: { name: string; city: string | null; data: object }[] = [
	{ name: 'José Ramos', city: 'Lisbon', data: {} },
	{ name: 'Ana Lima', city: 'Café', data: {} },
	{ name: 'Zoe Park', city: 'Oslo', data: {} },
	{ name: '李小龍', city: 'Hong Kong', data: {} },
	{ name: HANGUL_NFD, city: 'Seoul', data: {} },
	{ name: 'Sid Stamm', city: 'Austin', data: { hobbies: ['🚗 cars'] } }
];
const EVERYONE = MEMBERS.map((m) => m.name).sort();

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, $2)
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[SLUG, GROUP.name]
	);
	GROUP.id = rows[0].id;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	for (const [i, m] of MEMBERS.entries()) {
		await pool.query(
			`INSERT INTO member (group_id, email, name, city, data, status)
			 VALUES ($1, $2, $3, $4, $5::jsonb, 'active')`,
			[GROUP.id, `m${i}@example.org`, m.name, m.city, m.data]
		);
	}
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

test('an emoji beside a word is dropped, not AND-ed into an empty result', opts, async () => {
	const page = await directory('José 🚗');
	assert.deepEqual(names(page), ['José Ramos']);
	assert.equal(page.relaxed, false, 'the emoji forced the any-word fallback');
	assert.equal(page.unsearchable, false);
});

test('a query of only emoji lists everyone and says it had no words', opts, async () => {
	const page = await directory('🚗');
	assert.deepEqual(names(page), EVERYONE);
	assert.equal(page.unsearchable, true);
	assert.equal(page.filtered, false);
	assert.equal(page.relaxed, false);
	assert.equal(page.fuzzy, false);
});

test('an unaccented word finds the accented value', opts, async () => {
	assert.deepEqual(await exact('cafe'), ['Ana Lima']);
});

test('an accented word typed decomposed finds the composed value', opts, async () => {
	const nfd = 'café'.normalize('NFD');
	assert.notEqual(nfd, 'café');
	assert.deepEqual(await exact(nfd), ['Ana Lima']);
});

test('an accented word finds the unaccented value', opts, async () => {
	assert.deepEqual(await exact('Zoë'), ['Zoe Park']);
});

test('a CJK name is found by the exact CJK query', opts, async () => {
	assert.deepEqual(await exact('李小龍'), ['李小龍']);
});

test('a value stored decomposed is compared in NFC', opts, async () => {
	assert.deepEqual(await exact('김한결'), [HANGUL_NFD]);
	assert.deepEqual(await exact('한결'), [HANGUL_NFD]);
});

test('a word beside an emoji in a stored value still finds the member', opts, async () => {
	assert.deepEqual(await exact('cars'), ['Sid Stamm']);
});

test('the accent fold is IMMUTABLE, so an index can be built on it', opts, async () => {
	const { rows } = await pool!.query<{ v: string }>(
		`SELECT provolatile AS v FROM pg_proc WHERE proname = 'search_unaccent'`
	);
	assert.deepEqual(rows, [{ v: 'i' }]);
	await pool!.query(`EXPLAIN SELECT 1 FROM member WHERE search_unaccent(name) = 'x'`);
	const client = await pool!.connect();
	try {
		await client.query('BEGIN');
		await client.query(
			`CREATE INDEX b32_fold_probe ON member (search_unaccent(lower(normalize(name, NFC))))`
		);
	} finally {
		await client.query('ROLLBACK');
		client.release();
	}
});

test('R2 review: an accented query finds a checked visible label', opts, async () => {
    await pool!.query(
        `INSERT INTO member (group_id, email, name, data, status)
         VALUES ($1, 'checkbox-review@example.org', 'Dedicated Checker', $2::jsonb, 'active')`,
        [GROUP.id, { volunteer: 'TRUE' }]
    );
    const plain = await directory('volunteer');
    assert.deepEqual(names(plain), ['Dedicated Checker']);
    const accented = await directory('voluntéer');
    assert.deepEqual(names(accented), ['Dedicated Checker']);
    assert.equal(accented.fuzzy, false);
    assert.equal(accented.relaxed, false);
});

test('an unaccented word finds a checked box whose label is accented', opts, async () => {
	await pool!.query(
		`INSERT INTO member (group_id, email, name, data, status)
		 VALUES ($1, 'habitue@example.org', 'Regular Visitor', $2::jsonb, 'active'),
		        ($1, 'unticked@example.org', 'Unticked Visitor', $3::jsonb, 'active')`,
		[GROUP.id, { habitue: 'on', resident: 'on' }, { habitue: 'off', resident: 'on' }]
	);
	assert.deepEqual(await exact('habitue'), ['Regular Visitor']);
	assert.deepEqual(await exact('habitué'.normalize('NFD')), ['Regular Visitor']);
	const page = await directory('habit');
	assert.deepEqual(names(page), ['Regular Visitor']);
	assert.deepEqual(page.members[0].matched, [{ label: 'Café habitué', words: ['habit'] }]);
});

test('a checked box is named only for the word its label holds', opts, async () => {
	const page = await directory('voluntéer');
	assert.deepEqual(page.members[0].matched, [{ label: 'Volunteer', words: ['voluntéer'] }]);
	const both = await directory('habitué volunteer');
	assert.equal(both.relaxed, true, 'nobody ticked both, so neither box answers the other word');
	assert.deepEqual(names(both), ['Dedicated Checker', 'Regular Visitor']);
});

test('a private checkbox label is not matched, accented or not', opts, async () => {
	assert.deepEqual(names(await directory('resident')), []);
	assert.deepEqual(names(await directory('résident')), []);
});
