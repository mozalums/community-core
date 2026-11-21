import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'b29-search-years';
const GROUP = { id: '', slug: SLUG, name: 'B29 search years', landingMd: null, status: 'active' };

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

// Each member's tenure as stored: an absent key is left out of data entirely.
const TENURES: Record<string, { startYear?: string; endYear?: string }> = {
	'Start 2008': { startYear: '2008' },
	'Start 2008 End Empty': { startYear: '2008', endYear: '' },
	'End 2012': { endYear: '2012' },
	'Span 2008 2012': { startYear: '2008', endYear: '2012' },
	'Span 2010 2010': { startYear: '2010', endYear: '2010' },
	'Start Unknown End 2012': { startYear: 'unknown', endYear: '2012' },
	'Start 2012': { startYear: '2012' },
	'End 2008': { endYear: '2008' },
	'Span 2011 2015': { startYear: '2011', endYear: '2015' },
	'No Tenure': {},
	'Both Unknown': { startYear: 'unknown', endYear: 'ongoing' }
};

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
	for (const [name, data] of Object.entries(TENURES)) {
		await pool.query(
			`INSERT INTO member (group_id, email, name, data, status)
			 VALUES ($1, $2, $3, $4::jsonb, 'active')`,
			[GROUP.id, `${name.replace(/\W/g, '')}@example.org`, name, data]
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
	'a missing, empty or non-year bound is open; a member needs one valid bound',
	opts,
	async () => {
		assert.deepEqual(
			await directory('2010'),
			[
				'End 2012',
				'Span 2008 2012',
				'Span 2010 2010',
				'Start 2008',
				'Start 2008 End Empty',
				'Start Unknown End 2012'
			].sort()
		);
	}
);

test('several years combine with AND over an open bound', opts, async () => {
	const found = await directory('2010 2015');
	assert.ok(found.includes('Start 2008'), 'an open end spans both years');
	assert.ok(!found.includes('Span 2008 2012'), 'a span ending in 2012 does not reach 2015');
	assert.deepEqual(found, ['Start 2008', 'Start 2008 End Empty'].sort());
});
