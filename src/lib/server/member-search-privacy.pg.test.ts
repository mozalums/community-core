import assert from 'node:assert/strict';
import { after, before, test, mock } from 'node:test';
import { PRIVATE_SEARCH_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(PRIVATE_SEARCH_FIELDS) });

// The directory search, driven through the page loader a non-admin member
// reaches, against real rows. What it pins is a property of the answer: a term
// that only an admin-only value holds finds nobody, and `%` or `_` in the term
// is a character to find, not a pattern. The count is the oracle a member
// reads, so the count is what is asserted.
//
// The private values are seeded in member.data as well as private_data. Every
// write path keeps them out of data today, so a row holding one there is what a
// skin flipping a field from members to private leaves behind; search has to
// hold on such a row by the field's visibility, not by which column it sits in.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'b28-search-privacy';
const GROUP = { id: '', slug: SLUG, name: 'B28 search privacy', landingMd: null, status: 'active' };

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

const MEMBER = { id: 'u1', email: 'reader@example.org', subject: 'email:reader@example.org' };

async function directory(q: string): Promise<{ count: number; names: string[] }> {
	const href = `https://example.org/group/${SLUG}/members?q=${encodeURIComponent(q)}`;
	const out = (await load({
		params: { slug: SLUG },
		url: new URL(href),
		parent: async () => ({}),
		locals: { user: MEMBER }
	} as unknown as Parameters<typeof load>[0])) as {
		count: number;
		members: { name: string | null }[];
	};
	return { count: out.count, names: out.members.map((m) => m.name ?? '').sort() };
}

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
	const insert = (email: string, name: string, data: object, priv: object = {}) =>
		pool!.query(
			`INSERT INTO member (group_id, email, name, city, data, private_data, status)
			 VALUES ($1, $2, $3, 'Lisbon', $4::jsonb, $5::jsonb, 'active')`,
			[GROUP.id, email, name, JSON.stringify(data), JSON.stringify(priv)]
		);
	const secret = { phone: '+447791234567', shirtSize: 'XXL', whatsapp: 'TRUE' };
	await insert('stored-apart@example.org', 'Stored Apart', { bio: 'plain' }, secret);
	await insert('left-behind@example.org', 'Left Behind', { bio: 'plain', ...secret });
	await insert('percent@example.org', 'Per Cent', { bio: 'gives 100% always' });
	await insert('underscore@example.org', 'Under Score', { bio: 'writes snake_case' });
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

test('the search answers for a members-visible value', opts, async () => {
	assert.deepEqual((await directory('snake')).names, ['Under Score']);
	assert.equal((await directory('lisbon')).count, 4);
});

test('an admin-only value finds nobody, wherever it is stored', opts, async () => {
	for (const q of ['7791', '+4477', 'xxl', '447791234567']) {
		assert.deepEqual((await directory(q)).names, [], `q=${q} reached an admin-only value`);
	}
});

test('a private checkbox named by its label finds nobody', opts, async () => {
	assert.deepEqual((await directory('whatsapp')).names, []);
});

test('the directory payload carries no data and no private value', opts, async () => {
	for (const q of ['', 'lisbon']) {
		const href = `https://example.org/group/${SLUG}/members?q=${q}`;
		const out = (await load({
			params: { slug: SLUG },
			url: new URL(href),
			parent: async () => ({}),
			locals: { user: MEMBER }
		} as unknown as Parameters<typeof load>[0])) as { members: object[] };
		assert.equal(out.members.length, 4);
		for (const m of out.members) {
			assert.deepEqual(Object.keys(m).sort(), [
				'avatarId',
				'city',
				'id',
				'matched',
				'name',
				'ref',
				'starred'
			]);
		}
		assert.doesNotMatch(JSON.stringify(out), /447791234567|XXL/);
	}
});

test('% and _ in the term are matched as themselves', opts, async () => {
	assert.deepEqual((await directory('100%')).names, ['Per Cent']);
	// A lone wildcard has no letter or digit, so it searches nothing and the
	// page lists everyone, as it would for an empty box.
	const everyone = (await directory('')).names;
	assert.deepEqual((await directory('%')).names, everyone);
	assert.deepEqual((await directory('_')).names, everyone);
	assert.deepEqual((await directory('+4477%')).names, []);
	assert.deepEqual((await directory('z%z')).names, []);
	assert.deepEqual((await directory('e_c')).names, ['Under Score']);
});
