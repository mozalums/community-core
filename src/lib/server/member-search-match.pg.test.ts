import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { UNICODE_SEARCH_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(UNICODE_SEARCH_FIELDS) });

// Which members a query finds, in what order, and what each tile says matched,
// against real rows through the page loader a non-admin member reaches. The
// trigram typo pass reaches only queries the exact pass answered with nobody,
// so a short handle sharing three letters with a word no longer turns up for it.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'b31-search-match';
const GROUP = { id: '', slug: SLUG, name: 'B31 search match', landingMd: null, status: 'active' };

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

type Tile = { name: string | null; matched?: { label: string; words: string[] }[] };
type Page = { members: Tile[]; fuzzy?: boolean; relaxed: boolean };

async function directory(q: string): Promise<Page> {
	return (await load({
		params: { slug: SLUG },
		url: new URL(`https://example.org/group/${SLUG}/members?q=${encodeURIComponent(q)}`),
		parent: async () => ({}),
		locals: { user: { id: 'u1', email: 'r@example.org', subject: 'email:r@example.org' } }
	} as unknown as Parameters<typeof load>[0])) as Page;
}
const names = (p: Page) => p.members.map((m) => m.name ?? '');
const tile = (p: Page, name: string) => p.members.find((m) => m.name === name);

const MEMBERS: { name: string; city: string; data: object }[] = [
	{ name: 'Carlo Frinolli', city: 'Rome', data: { handle: 'carlo' } },
	{ name: 'Sid Stamm', city: 'Austin', data: { handle: 'sid', hobbies: ['cars'] } },
	{ name: 'Quiet One', city: 'Oslo', data: { pastime: 'cars' } },
	{ name: 'Both Kinds', city: 'Lima', data: { hobbies: ['kites'], pastime: 'kites' } },
	{ name: 'Aaron Able', city: 'Quito', data: { hobbies: ['stonework'] } },
	{ name: 'Bea Bee', city: 'Quito', data: { hobbies: ['stone'] } },
	{ name: 'Cal Stone', city: 'Quito', data: {} }
];

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
	for (const m of MEMBERS) {
		await pool.query(
			`INSERT INTO member (group_id, email, name, city, data, status)
			 VALUES ($1, $2, $3, $4, $5::jsonb, 'active')`,
			[GROUP.id, `${m.name.replace(/\W/g, '')}@example.org`, m.name, m.city, m.data]
		);
	}
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

test(
	'a word finds the member whose hobby it is, not one whose handle resembles it',
	opts,
	async () => {
		const page = await directory('cars');
		assert.deepEqual(names(page), ['Sid Stamm']);
		assert.equal(page.fuzzy ?? false, false);
	}
);

test('a misspelt name finds the member through the typo pass, which says so', opts, async () => {
	const page = await directory('Frinoli');
	assert.deepEqual(names(page), ['Carlo Frinolli']);
	assert.equal(page.fuzzy, true);
	assert.deepEqual(tile(page, 'Carlo Frinolli')?.matched, [{ label: 'Name', words: ['Frinoli'] }]);
});

test('each tile names the visible field the word matched', opts, async () => {
	const page = await directory('cars');
	assert.deepEqual(tile(page, 'Sid Stamm')?.matched, [{ label: 'Hobbies', words: ['cars'] }]);
});

test('a private field holding the word is neither a match nor named', opts, async () => {
	assert.ok(!names(await directory('cars')).includes('Quiet One'));
	const page = await directory('kites');
	assert.deepEqual(names(page), ['Both Kinds']);
	assert.deepEqual(tile(page, 'Both Kinds')?.matched, [{ label: 'Hobbies', words: ['kites'] }]);
	assert.doesNotMatch(JSON.stringify(page), /Pastime/);
});

test(
	'a whole-word name match outranks a whole-word field match, which outranks a substring',
	opts,
	async () => {
		assert.deepEqual(names(await directory('stone')), ['Cal Stone', 'Bea Bee', 'Aaron Able']);
	}
);

test('R3 review: full-text-only matches name their visible fields', opts, async () => {
    const fixtures = [
        { name: 'Dara O Brien', data: {} },
        { name: 'Visible Collector', data: { hobbies: ['o brien'] } }
    ];
    for (const m of fixtures) {
        await pool!.query(
            `INSERT INTO member (group_id, email, name, data, status)
             VALUES ($1, $2, $3, $4::jsonb, 'active')`,
            [GROUP.id, `${m.name.replace(/\W/g, '')}@example.org`, m.name, m.data]
        );
    }
    const page = await directory("o'brien");
    assert.deepEqual(names(page).sort(), ['Dara O Brien', 'Visible Collector']);
    assert.deepEqual(page.members.map(m => ({name: m.name, matched: m.matched})), [
        {name: 'Dara O Brien', matched: [{label: 'Name', words: ["o'brien"]}]},
        {name: 'Visible Collector', matched: [{label: 'Hobbies', words: ["o'brien"]}]}
    ]);
});

test('R4 review: a whole checkbox label outranks a value substring', opts, async () => {
    const fixtures = [
        { name: 'Cal Volunteer', data: {} },
        { name: 'Bea Bee', data: { volunteer: 'TRUE' } },
        { name: 'Aaron Able', data: { bio: 'volunteering' } }
    ];
    for (const m of fixtures) {
        await pool!.query(
            `INSERT INTO member (group_id, email, name, data, status)
             VALUES ($1, $2, $3, $4::jsonb, 'active')
             ON CONFLICT (group_id, email) DO UPDATE SET data = EXCLUDED.data`,
            [GROUP.id, `${m.name.replace(/\W/g, '')}@example.org`, m.name, m.data]
        );
    }
    const page = await directory('volunteer');
    assert.deepEqual(names(page), ['Cal Volunteer', 'Bea Bee', 'Aaron Able']);
});

test('review regression: a 101-word query still returns rows', opts, async () => {
    const q = Array.from({ length: 101 }, (_, i) => `token${i}`).join(' ');
    await pool!.query(
        `INSERT INTO member (group_id, email, name, data, status)
         VALUES ($1, 'long-query@example.org', 'Long Query', $2::jsonb, 'active')`,
        [GROUP.id, { bio: q }]
    );
    assert.deepEqual(names(await directory(q)), ['Long Query']);
});

test('a negated word filters members out and is never a reason to let one in', opts, async () => {
	const kept = await directory('carlo -cars');
	assert.deepEqual(names(kept), ['Carlo Frinolli']);
	assert.ok(!JSON.stringify(kept.members).includes('-cars'));
	// Neither the relaxed pass nor the typo pass may loosen the exclusion.
	assert.deepEqual(names(await directory('sid -cars')), []);
});

test('review regression: unquoted full-text terms may match different visible fields', opts, async () => {
	for (const [name, hobbies] of [['Xena', ['cars']], ['Yara', ['boats']]] as const) {
		await pool!.query(
			`INSERT INTO member (group_id, email, name, data, status)
			 VALUES ($1, $2, $3, $4::jsonb, 'active')`,
			[GROUP.id, `${name}@example.org`, name, { bio: 'astronomy', hobbies }]
		);
	}
	assert.deepEqual(names(await directory('astronomy,cars')), ['Xena']);
});

test('audit: a negated checkbox label excludes a checked member', opts, async () => {
	await pool!.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool!.query(
		`INSERT INTO member (group_id, email, name, data, status) VALUES
		 ($1, 'checked@example.org', 'Checked Person', '{"volunteer":"on"}', 'active'),
		 ($1, 'unchecked@example.org', 'Unchecked Person', '{}', 'active')`,
		[GROUP.id]
	);
	assert.deepEqual(names(await directory('volunteer')), ['Checked Person']);
	assert.deepEqual(names(await directory('-volunteer')), ['Unchecked Person']);
});

async function boxFixture(checked: object, unchecked: object) {
	await pool!.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool!.query(
		`INSERT INTO member (group_id, email, name, data, status) VALUES
		 ($1, 'checked@example.org', 'Checked Person', $2::jsonb, 'active'),
		 ($1, 'unchecked@example.org', 'Unchecked Person', $3::jsonb, 'active')`,
		[GROUP.id, checked, unchecked]
	);
}

test('a negated checkbox label beside a name word excludes in both passes and names nothing', opts, async () => {
	await boxFixture({ volunteer: 'TRUE' }, {});
	const strict = await directory('person -volunteer');
	assert.deepEqual(names(strict), ['Unchecked Person']);
	assert.equal(strict.relaxed, false);
	assert.deepEqual(tile(strict, 'Unchecked Person')?.matched, [{ label: 'Name', words: ['person'] }]);
	// "zzzz" matches nobody, so the AND pass is empty and the OR pass answers.
	const relaxed = await directory('checked zzzz -volunteer');
	assert.deepEqual(names(relaxed), ['Unchecked Person']);
	assert.equal(relaxed.relaxed, true);
	assert.ok(!JSON.stringify(relaxed.members).includes('volunteer'));
});

test('a negated accented checkbox label excludes under any spelling', opts, async () => {
	await boxFixture({ habitue: 'on' }, {});
	for (const q of ['-habitue', '-habitué', '-habitué', '-CAFÉ', '-cafe']) {
		assert.deepEqual(names(await directory(q)), ['Unchecked Person'], q);
	}
});

test('a negated private checkbox label excludes nobody', opts, async () => {
	await boxFixture({ resident: 'on' }, {});
	for (const q of ['-resident', '-Résident', '-résident']) {
		assert.deepEqual(names(await directory(q)), ['Checked Person', 'Unchecked Person'], q);
	}
});
