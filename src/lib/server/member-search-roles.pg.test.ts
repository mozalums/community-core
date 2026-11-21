import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

// A role or typed column with one private field behind it and one visible:
// the private part must not move the answer, the visible part must still find
// the member. A start year is private while the end year is not, and the
// linkedin column joins a visible website with a private portfolio.
const MIXED_FIELDS = [
	...EVERY_ROLE_FIELDS.map((f) =>
		f.key === 'startYear' ? { ...f, visibility: 'private' as const } : f
	),
	{
		key: 'portfolio',
		label: 'Portfolio',
		type: 'url' as const,
		visibility: 'private' as const,
		column: 'linkedin' as const
	}
];
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(MIXED_FIELDS) });

//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'b28-search-roles';
const GROUP = { id: '', slug: SLUG, name: 'B28 search roles', landingMd: null, status: 'active' };

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

async function directory(q: string): Promise<string[]> {
	const out = (await load({
		params: { slug: SLUG },
		url: new URL(`https://example.org/group/${SLUG}/members?q=${encodeURIComponent(q)}`),
		parent: async () => ({}),
		locals: { user: { id: 'u1', email: 'r@example.org', subject: 'email:r@example.org' } }
	} as unknown as Parameters<typeof load>[0])) as { members: { name: string | null }[] };
	return out.members.map((m) => m.name ?? '').sort();
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
	const insert = (name: string, linkedin: string | null, data: object, priv: object = {}) =>
		pool!.query(
			`INSERT INTO member (group_id, email, name, linkedin, data, private_data, status)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'active')`,
			[GROUP.id, `${name.replace(/\W/g, '')}@example.org`, name, linkedin, data, priv]
		);
	// The start year sits in data as a skin flipping it to private leaves it.
	await insert('Half Tenure', null, { startYear: '2013', endYear: '2015' });
	await insert(
		'Two Sites',
		'qzxpublicsite qzxprivatefolio',
		{ website: 'qzxpublicsite' },
		{ portfolio: 'qzxprivatefolio' }
	);
	await insert('Qzxcolumnname Only', null, {});
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

test('a private tenure bound does not narrow a year beside a visible one', opts, async () => {
	assert.deepEqual(await directory('2014'), [], 'the private start year placed 2014 in the span');
	assert.deepEqual(await directory('2015'), ['Half Tenure'], 'the visible end year is a word');
});

test('a typed column joining a private field does not carry it', opts, async () => {
	assert.deepEqual(await directory('qzxprivatefolio'), []);
	assert.deepEqual(await directory('qzxpublicsite'), ['Two Sites']);
});

test(
	'a column whose fields are all visible is searched with nothing stored behind it',
	opts,
	async () => {
		assert.deepEqual(await directory('qzxcolumnname'), ['Qzxcolumnname Only']);
	}
);
