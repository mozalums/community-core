import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { SEARCH_MATCH_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(SEARCH_MATCH_FIELDS.map((f) =>
	f.key === 'familyName' ? { ...f, visibility: 'private' as const } : f
)) });

// A checkbox marker remains a word when a visible text field stores it.
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'b31-review-marker-words';
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
    { name: 'On Zulu', city: 'Rome', data: { givenName: 'On', familyName: 'Zulu' } },
    { name: 'Ada On', city: 'Rome', data: { givenName: 'Ada', familyName: 'On', hobbies: ['on'] } },
    { name: 'Aaron Reed', city: 'Rome', data: { givenName: 'Aaron', familyName: 'Reed', hobbies: ['onyx'] } },
    { name: 'Private On', city: 'Rome', data: { givenName: 'Private', familyName: 'On' } },
    { name: 'Zoe West', city: 'Rome', data: { givenName: 'Zoe', familyName: 'West', country: 'NO' } },
    { name: 'Cora Reed', city: 'Rome', data: { givenName: 'Cora', familyName: 'Reed', bio: 'noble' } },
    { name: 'Private No', city: 'Rome', data: { givenName: 'Private', familyName: 'No' } }
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

test('R4 review: visible name text equal to a checkbox marker keeps the name tier', opts, async () => {
    const page = await directory('on');
    assert.ok(!names(page).includes('Private On'));
    assert.deepEqual(names(page), ['On Zulu', 'Ada On', 'Aaron Reed']);
    assert.deepEqual(tile(page, 'On Zulu')?.matched, [{ label: 'Given name', words: ['on'] }]);
});

test('R4 review: visible scalar text equal to a checkbox marker outranks a substring', opts, async () => {
    const page = await directory('no');
    assert.ok(!names(page).includes('Private No'));
    assert.deepEqual(names(page), ['Zoe West', 'Cora Reed']);
});
