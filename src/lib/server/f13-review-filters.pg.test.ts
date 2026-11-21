import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { FILTER_SEARCH_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

// Country, city and both tenure years filter; a members-visible "Other place"
// does not, and the private phone cannot.
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(FILTER_SEARCH_FIELDS.map((f) => f.key === 'givenName' ? { ...f, filter: 'exact' } : f)) });

//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'f13-review-probes';
const GROUP = { id: '', slug: SLUG, name: 'F13 search filters', landingMd: null, status: 'active' };

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
const { searchMembers } = await import('./members');
const { load } = await import('../../routes/group/[slug]/members/+page.server');

type Directory = {
	members: { name: string | null }[];
	relaxed: boolean;
	fuzzy: boolean;
	filters: { label: string; value: string; without: string }[];
};

async function directory(query: string): Promise<Directory & { names: string[] }> {
	const out = (await load({
		params: { slug: SLUG },
		url: new URL(`https://example.org/group/${SLUG}/members?${query}`),
		parent: async () => ({}),
		locals: { user: { id: 'u1', email: 'r@example.org', subject: 'email:r@example.org' } }
	} as unknown as Parameters<typeof load>[0])) as Directory;
	return { ...out, names: out.members.map((m) => m.name ?? '').sort() };
}
const names = async (query: string) => (await directory(query)).names;

// `city` is the promoted column alone, as a row the sheet filled may hold it,
// so a filter on City reads the column the profile shows.
type Row = { city?: string; data: Record<string, string>; privateData?: Record<string, string> };
const MEMBERS: Record<string, Row> = {
	'US Portland': {
		city: 'Portland',
		data: { country: 'United States', givenName: 'US', familyName: 'Portland', startYear: '2012', endYear: '2015' }
	},
	'US Atlanta': {
		city: 'Atlanta',
		data: { country: 'United States', town: 'Georgia', startYear: '2010', endYear: '2014' }
	},
	'UK London': {
		city: 'London',
		data: { country: 'United Kingdom', startYear: '2008', endYear: '' }
	},
	'GE Tbilisi': {
		city: 'Tbilisi',
		data: { country: 'Georgia', startYear: '2012', endYear: '2020' }
	},
	'CA Toronto': {
		city: 'Toronto',
		data: { country: 'ＣＡＮＡＤＡ', startYear: '2011' },
		privateData: { phone: '555' }
	},
	'Wild Exact': { data: { country: 'A%B_C' } },
	'Wild Other': { data: { country: 'AxxByC' } }
};
const EVERYONE = Object.keys(MEMBERS).sort();

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
	for (const [name, r] of Object.entries(MEMBERS)) {
		await pool.query(
			`INSERT INTO member (group_id, email, name, city, data, private_data, status)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'active')`,
			[
				GROUP.id,
				`${name.replace(/\W/g, '')}@example.org`,
				name,
				r.city ?? null,
				r.data,
				r.privateData ?? {}
			]
		);
	}
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});


test('F13 review R2: an exact given-name filter reads that data field, not the joined name', opts, async () => {
    assert.deepEqual(
        { part: await names('givenName=US'), whole: await names('givenName=US%20Portland') },
        { part: ['US Portland'], whole: [] }
    );
});

test('F13 review R2: stored surrounding whitespace folds like the profile and query', opts, async () => {
    await pool!.query(`UPDATE member SET data = jsonb_set(data, '{country}', $1::jsonb) WHERE group_id = $2 AND name = 'CA Toronto'`, [JSON.stringify('﻿ＣＡＮＡＤＡ﻿'), GROUP.id]);
    assert.deepEqual(await names('country=canada'), ['CA Toronto']);
});
