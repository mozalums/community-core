import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { MIGRATIONS, UNCONVERTED_LINKEDIN_KEY, convertLinkedinValue } from './migrations';
import { currentSkin } from '../skin/load';

// Migration 22 against real Postgres, applied to a database at version
// 21 holding LinkedIn values in every form a row could have stored. Each case
// builds that database in a schema of its own inside one transaction and rolls
// it back.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
after(async () => {
	await pool?.end();
});

const m22 = MIGRATIONS.find((m) => m.version === 22)!;
// The default skin's links field, which the migration reads from the running skin.
const LINKS = currentSkin().skin.fields.find((f) => f.type === 'links')!.key;

async function atVersion21<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
	const c = await pool!.connect();
	const schema = `m22_${randomBytes(4).toString('hex')}`;
	try {
		await c.query('BEGIN');
		await c.query('SELECT pg_advisory_xact_lock(4607001)');
		await c.query(`CREATE SCHEMA ${schema}`);
		await c.query(`SET LOCAL search_path TO ${schema}, public`);
		for (const m of MIGRATIONS.filter((x) => x.version <= 21)) await c.query(m.sql);
		return await fn(c);
	} finally {
		await c.query('ROLLBACK');
		c.release();
	}
}

// Every way a LinkedIn value reached a row before this migration: the typed
// column with its JSON copy, the column alone, a tracking URL, an empty value,
// an https address that is no LinkedIn profile, and text that is no address.
const ROWS: { email: string; column: string | null; data: Record<string, unknown> }[] = [
	{ email: 'bare@example.org', column: 'ravinald', data: { linkedin: 'ravinald' } },
	{
		email: 'full@example.org',
		column: 'https://www.linkedin.com/in/ada-l/',
		data: { linkedin: 'https://www.linkedin.com/in/ada-l/', bio: 'Hi' }
	},
	{
		email: 'trk@example.org',
		column: 'https://www.linkedin.com/in/bo-k?trk=public_profile_browsemap',
		data: {}
	},
	{ email: 'empty@example.org', column: '', data: { linkedin: '' } },
	{
		email: 'bad@example.org',
		column: 'https://www.linkedin.com/company/acme',
		data: { linkedin: 'https://www.linkedin.com/company/acme' }
	},
	{ email: 'text@example.org', column: 'Ada of Orchard', data: {} }
];

async function seed(c: pg.PoolClient): Promise<string> {
	const g = await c.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ('m22', 'M22') RETURNING id`
	);
	const groupId = g.rows[0].id;
	for (const r of ROWS) {
		await c.query(
			`INSERT INTO member (group_id, email, name, linkedin, data) VALUES ($1, $2, 'X', $3, $4::jsonb)`,
			[groupId, r.email, r.column, JSON.stringify(r.data)]
		);
	}
	await c.query(
		`INSERT INTO access_request (group_id, email, name, data)
		 VALUES ($1, 'nomi@example.org', 'Nomi', '{"name":"Nomi","linkedin":"https://linkedin.com/in/nomi-v"}'),
		        ($1, 'ola@example.org', 'Ola', '{"name":"Ola","linkedin":"not a profile"}')`,
		[groupId]
	);
	return groupId;
}

const bags = async (c: pg.PoolClient, email: string) =>
	(
		await c.query<{ data: Record<string, unknown>; private_data: Record<string, unknown> }>(
			`SELECT data, private_data FROM member WHERE email = $1`,
			[email]
		)
	).rows[0];

test('pg: migration 22 converts every LinkedIn value to a handle and drops the column', opts, () =>
	atVersion21(async (c) => {
		await seed(c);
		const line = await m22.run!(c);
		await c.query(m22.sql);
		assert.equal(
			line,
			`migration 22: 4 LinkedIn value(s) converted, 1 moved to the website link, 2 kept under ${UNCONVERTED_LINKEDIN_KEY} (pnpm report-bad-profile-urls lists them)`
		);

		const linkedin = (handle: string) => ({ [LINKS]: [{ site: 'linkedin', handle }] });
		assert.deepEqual(await bags(c, 'bare@example.org'), {
			data: linkedin('ravinald'),
			private_data: {}
		});
		assert.deepEqual(await bags(c, 'full@example.org'), {
			data: { bio: 'Hi', ...linkedin('ada-l') },
			private_data: {}
		});
		assert.deepEqual(await bags(c, 'trk@example.org'), {
			data: linkedin('bo-k'),
			private_data: {}
		});
		// An empty value is no link and leaves no key behind.
		assert.deepEqual(await bags(c, 'empty@example.org'), { data: {}, private_data: {} });
		// An https address that is no LinkedIn profile becomes the website link.
		assert.deepEqual(await bags(c, 'bad@example.org'), {
			data: {
				[LINKS]: [{ site: 'website', handle: 'https://www.linkedin.com/company/acme' }]
			},
			private_data: {}
		});
		// What neither site accepts is kept, privately, for an admin to fix.
		assert.deepEqual(await bags(c, 'text@example.org'), {
			data: {},
			private_data: { [UNCONVERTED_LINKEDIN_KEY]: 'Ada of Orchard' }
		});

		const requests = await c.query<{ email: string; data: Record<string, unknown> }>(
			`SELECT email::text AS email, data FROM access_request ORDER BY email`
		);
		assert.deepEqual(requests.rows, [
			{ email: 'nomi@example.org', data: { name: 'Nomi', ...linkedin('nomi-v') } },
			{
				email: 'ola@example.org',
				data: { name: 'Ola', [UNCONVERTED_LINKEDIN_KEY]: 'not a profile' }
			}
		]);

		const cols = await c.query(
			`SELECT 1 FROM information_schema.columns
			  WHERE table_schema = current_schema() AND table_name = 'member' AND column_name = 'linkedin'`
		);
		assert.equal(cols.rowCount, 0, 'member.linkedin survived');
	})
);

test(
	'pg: the rebuilt search index matches a handle, and not the words of the stored list',
	opts,
	() =>
		atVersion21(async (c) => {
			await seed(c);
			await m22.run!(c);
			await c.query(m22.sql);
			const hits = async (word: string) =>
				(
					await c.query<{ email: string }>(
						`SELECT email::text AS email FROM member
					  WHERE search_tsv @@ to_tsquery('simple', $1) ORDER BY email`,
						[word]
					)
				).rows.map((r) => r.email);
			assert.deepEqual(await hits('ravinald'), ['bare@example.org']);
			assert.deepEqual(await hits('site'), []);
			assert.deepEqual(await hits('linkedin'), []);
			// The kept value is private, and search never reads private_data.
			assert.deepEqual(await hits('orchard'), []);
		})
);

test(
	'pg: after migration 22, search still matches a structured value that is not a links list',
	opts,
	() =>
		atVersion21(async (c) => {
			const g = await c.query<{ id: string }>(
				`INSERT INTO "group" (slug, name) VALUES ('m22', 'M22') RETURNING id`
			);
			await c.query(
				`INSERT INTO member (group_id, email, name, data) VALUES ($1, 'ada@example.org', 'Ada', $2::jsonb)`,
				[
					g.rows[0].id,
					JSON.stringify({
						bio: [{ handle: 'ada', project: 'orchard' }],
						club: [{ site: 'chess' }]
					})
				]
			);
			const hits = async (word: string) =>
				Number(
					(
						await c.query<{ n: string }>(
							`SELECT count(*) AS n FROM member WHERE search_tsv @@ to_tsquery('simple', $1)`,
							[word]
						)
					).rows[0].n
				);
			assert.deepEqual([await hits('orchard'), await hits('chess')], [1, 1], 'at version 21');
			await m22.run!(c);
			await c.query(m22.sql);
			assert.deepEqual([await hits('orchard'), await hits('chess')], [1, 1], 'at version 22');
		})
);

test('a skin with no links field keeps the value rather than dropping it', () => {
	const bags = { data: { linkedin: 'https://www.linkedin.com/in/ada' }, privateData: {} };
	assert.equal(convertLinkedinValue(null, bags, []), 'kept');
	assert.deepEqual(bags, {
		data: {},
		privateData: { [UNCONVERTED_LINKEDIN_KEY]: 'https://www.linkedin.com/in/ada' }
	});
});

test('a different LinkedIn link the member already holds wins, and the value is kept for the report', () => {
	const fields = currentSkin().skin.fields;
	const bags = {
		data: {
			linkedin: 'https://www.linkedin.com/in/old',
			[LINKS]: [{ site: 'linkedin', handle: 'mine' }]
		},
		privateData: {}
	};
	assert.equal(convertLinkedinValue('https://www.linkedin.com/in/new', bags, fields), 'kept');
	assert.deepEqual(bags.data, { [LINKS]: [{ site: 'linkedin', handle: 'mine' }] });
	assert.deepEqual(bags.privateData, {
		[UNCONVERTED_LINKEDIN_KEY]: 'https://www.linkedin.com/in/new'
	});
	const same = { data: { [LINKS]: [{ site: 'linkedin', handle: 'new' }] }, privateData: {} };
	assert.equal(convertLinkedinValue('https://www.linkedin.com/in/new', same, fields), 'linkedin');
	assert.deepEqual(same.privateData, {});
});

test('only a value already written as an https address moves to the website link', () => {
	const fields = currentSkin().skin.fields;
	const bare = { data: {}, privateData: {} };
	assert.equal(convertLinkedinValue('example.org/about', bare, fields), 'kept');
	assert.deepEqual(bare.privateData, { [UNCONVERTED_LINKEDIN_KEY]: 'example.org/about' });
	const full = { data: {}, privateData: {} };
	assert.equal(convertLinkedinValue('https://example.org/about', full, fields), 'website');
	assert.deepEqual(full.data, { [LINKS]: [{ site: 'website', handle: 'https://example.org/about' }] });
});

test('the column wins over its JSON copy', () => {
	const fields = currentSkin().skin.fields;
	const fresh = { data: { linkedin: 'https://www.linkedin.com/in/old' }, privateData: {} };
	convertLinkedinValue('https://www.linkedin.com/in/new', fresh, fields);
	assert.deepEqual(fresh.data, { [LINKS]: [{ site: 'linkedin', handle: 'new' }] });
});
