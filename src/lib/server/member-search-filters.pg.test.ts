import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { FILTER_SEARCH_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

// Country, city and both tenure years filter; a members-visible "Other place"
// does not, and the private phone cannot.
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(FILTER_SEARCH_FIELDS) });

//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'f13-search-filters';
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
		data: { country: 'United States', startYear: '2012', endYear: '2015' }
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

test('F13 R2: a filter is equality on the whole value, not a substring', opts, async () => {
	assert.deepEqual(await names('country=United'), [], 'United matched United States');
	assert.deepEqual(await names('country=United%20States'), ['US Atlanta', 'US Portland']);
	// Search finds Georgia wherever a field holds it; the filter only in Country.
	assert.deepEqual(await names('q=georgia'), ['GE Tbilisi', 'US Atlanta']);
	assert.deepEqual(await names('country=Georgia'), ['GE Tbilisi']);
	assert.deepEqual(await names('city=Portland'), ['US Portland'], 'the city column is read');
	assert.deepEqual(await names('city=Port'), []);
});

test('F13 R2: case, surrounding space and NFKC fold on both sides', opts, async () => {
	assert.deepEqual(await names('country=%20%20united%20STATES%20'), ['US Atlanta', 'US Portland']);
	assert.deepEqual(await names('country=canada'), ['CA Toronto'], 'fullwidth stored value');
	assert.deepEqual(
		await names(`country=${encodeURIComponent('ＵＮＩＴＥＤ ＳＴＡＴＥＳ')}`),
		['US Atlanta', 'US Portland'],
		'fullwidth query value'
	);
});

test('F13 R2: filters AND with each other and with q', opts, async () => {
	assert.deepEqual(await names('country=United%20States&startYear=2012'), ['US Portland']);
	assert.deepEqual(await names('country=United%20States&q=atlanta'), ['US Atlanta']);
	assert.deepEqual(await names('country=Georgia&q=atlanta'), []);
});

test('F13 R2: a blank End Year never matches an endYear filter', opts, async () => {
	assert.deepEqual(await names('endYear=2015'), ['US Portland']);
	assert.deepEqual(await names('endYear=2020'), ['GE Tbilisi']);
	// A blank parameter is no filter at all, so it cannot select the blank rows.
	const blank = await directory('endYear=');
	assert.deepEqual(blank.names, EVERYONE);
	assert.deepEqual(blank.filters, []);
	const results = await searchMembers(GROUP.id, { filters: [{ key: 'endYear', value: '  ' }] });
	assert.equal(results.members.length, EVERYONE.length);
});

test('F13 R3: startYear means started then; a year in q means around then', opts, async () => {
	assert.deepEqual(await names('startYear=2012'), ['GE Tbilisi', 'US Portland']);
	assert.deepEqual(await names('q=2012'), [
		'CA Toronto',
		'GE Tbilisi',
		'UK London',
		'US Atlanta',
		'US Portland'
	]);
});

test('F13 R2: a private or non-filterable key is ignored and not echoed', opts, async () => {
	for (const query of ['phone=555', 'town=Georgia', 'name=US%20Portland', 'bogus=1']) {
		const out = await directory(query);
		assert.deepEqual(out.names, EVERYONE, query);
		// The page echoes parameters through these two keys and no other.
		assert.deepEqual(out.filters, [], query);
		assert.deepEqual((out as unknown as { query: unknown }).query, { q: '' }, query);
	}
	// searchMembers refuses it too, whoever calls it.
	const direct = await searchMembers(GROUP.id, { filters: [{ key: 'phone', value: '555' }] });
	assert.equal(direct.members.length, EVERYONE.length);
});

test('F13 R2: % and _ in a value match only themselves', opts, async () => {
	assert.deepEqual(await names(`country=${encodeURIComponent('A%B_C')}`), ['Wild Exact']);
	assert.deepEqual(await names(`country=${encodeURIComponent('A%')}`), []);
	assert.deepEqual(await names(`country=${encodeURIComponent('A_x%')}`), []);
});

test('F13 R3: neither the relaxed nor the fuzzy pass drops a filter', opts, async () => {
	// Without the filter, "portland atlanta" relaxes to OR and finds both.
	const open = await directory('q=portland%20atlanta');
	assert.ok(open.relaxed);
	assert.deepEqual(open.names, ['US Atlanta', 'US Portland']);
	const relaxed = await directory('country=Georgia&q=portland%20atlanta');
	assert.deepEqual(relaxed.names, []);
	assert.equal(relaxed.relaxed, false);

	// Without the filter, a misspelt city finds Portland by trigram.
	assert.deepEqual((await directory('q=portlnd')).names, ['US Portland']);
	const fuzzy = await directory('country=Georgia&q=portlnd');
	assert.deepEqual(fuzzy.names, []);
	assert.equal(fuzzy.fuzzy, false);
	// And a relaxed pass under a filter keeps only the filter's members.
	const kept = await directory('country=United%20States&q=portland%20tbilisi');
	assert.ok(kept.relaxed);
	assert.deepEqual(kept.names, ['US Portland']);
});

test(
	'F13 R5: each filter carries the link that drops it and keeps the rest and q',
	opts,
	async () => {
		const out = await directory('startYear=2012&q=portland&country=United%20States&starred=0');
		assert.deepEqual(out.filters, [
			{
				label: 'Country',
				value: 'United States',
				without: '?q=portland&startYear=2012'
			},
			{
				label: 'Start year',
				value: '2012',
				without: '?q=portland&country=United%20States'
			}
		]);
		const one = await directory('country=Georgia');
		assert.deepEqual(one.filters, [{ label: 'Country', value: 'Georgia', without: '' }]);
	}
);
