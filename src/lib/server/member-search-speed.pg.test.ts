import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

// Checkboxes, a links field and free text, the mix a real roster carries:
// each kind of value is read by its own branch of the search SQL, and one
// slow branch made a 272-member search take three seconds per statement.
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const SLUG = 'search-speed';
const GROUP = { id: '', slug: SLUG, name: 'Search speed', landingMd: null, status: 'active' };
const MEMBERS = 1000;
// A search is timed against an unfiltered directory load on the same
// machine, so a slow runner slows both. Measured at 1000 members: a sound
// search runs at 9-19 times a browse, the per-value-function regression at
// 130-420 times. The floor keeps timer noise on a few-millisecond browse
// from failing a search that is fast in absolute terms.
const MAX_RATIO = 60;
const FLOOR_MS = 300;

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

async function search(q: string): Promise<number> {
	const start = performance.now();
	await load({
		params: { slug: SLUG },
		url: new URL(`https://example.org/group/${SLUG}/members?q=${encodeURIComponent(q)}`),
		parent: async () => ({}),
		locals: { user: { id: 'u1', email: 'r@example.org', subject: 'email:r@example.org' } }
	} as unknown as Parameters<typeof load>[0]);
	return performance.now() - start;
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
	await pool.query(
		`INSERT INTO member (group_id, email, name, city, data, status)
		 SELECT $1, 'm' || i || '@example.org', 'Given' || i || ' Family' || i, 'City' || (i % 40),
		        jsonb_build_object(
		            'givenName', 'Given' || i, 'familyName', 'Family' || i,
		            'bio', 'Worked on project ' || i || ' and liked it',
		            'staff', CASE WHEN i % 2 = 0 THEN 'TRUE' ELSE 'FALSE' END,
		            'volunteer', CASE WHEN i % 3 = 0 THEN 'TRUE' ELSE 'FALSE' END,
		            'publicProfile', 'TRUE',
		            'country', 'Country' || (i % 20), 'city', 'City' || (i % 40),
		            'interests', jsonb_build_array('hiking', 'interest' || i),
		            'profiles', jsonb_build_array(jsonb_build_object('site', 'github', 'handle', 'user' || i))),
		        'active'
		   FROM generate_series(1, $2::int) AS i`,
		[GROUP.id, MEMBERS]
	);
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

test(`a search over ${MEMBERS} members costs at most ${MAX_RATIO} unfiltered loads`, opts, async () => {
	await search('warmup');
	const browse = Math.min(await search(''), await search(''), await search(''));
	for (const q of ['Family150', 'nobodyhasthis', 'hiking', 'user42']) {
		const ms = await search(q);
		assert.ok(
			ms < FLOOR_MS || ms < MAX_RATIO * browse,
			`"${q}" took ${Math.round(ms)} ms, ${(ms / browse).toFixed(0)} times an unfiltered load (${Math.round(browse)} ms)`
		);
	}
});
