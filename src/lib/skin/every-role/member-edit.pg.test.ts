import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import pg from 'pg';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// Profile save against a real Postgres for a skin that names a member in two
// parts, keeps the address as a field and has a public-profile checkbox. The
// rest is in src/lib/server/member-edit.pg.test.ts.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 6 }) : null;

let failMemberDelete = false;
let failAudit = false;
const revoked: string[] = [];

mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => pool,
		query: (text: string, values?: unknown[]) => {
			if (failMemberDelete && /^DELETE FROM member WHERE/.test(text)) {
				throw new Error('injected DB delete failure');
			}
			return pool!.query(text, values);
		},
		withTransaction: async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
			const client = await pool!.connect();
			const real = client.query.bind(client) as (t: string, v?: unknown[]) => Promise<unknown>;
			const injecting = (text: string, values?: unknown[]) => {
				if (failMemberDelete && /^DELETE FROM member WHERE/.test(text)) {
					throw new Error('injected DB delete failure');
				}
				if (failAudit && /INSERT INTO audit_event/.test(text)) {
					throw new Error('injected audit failure');
				}
				return real(text, values);
			};
			try {
				await client.query('BEGIN');
				const out = await fn({ query: injecting } as unknown as pg.PoolClient);
				await client.query('COMMIT');
				return out;
			} catch (e) {
				await client.query('ROLLBACK');
				throw e;
			} finally {
				client.release();
			}
		}
	}
});
const GROUP = {
	id: '',
	slug: 'f04-member-edit-roles',
	name: 'F04 edit roles',
	landingMd: null,
	status: 'active'
};
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});
mock.module('$lib/server/avatars', {
	namedExports: {
		emailMd5: (s: string) => s,
		ensureAvatarRows: async () => new Map(),
		avatarIdFor: async () => null,
		deleteAvatar: async () => {},
		getAvatarByEmail: async () => null,
		recordGravatar: async () => {}
	}
});
mock.module('$lib/server/session-store', {
	namedExports: {
		deleteSession: async () => {},
		deleteUserSessions: async (subject: string) => {
			revoked.push(subject);
			return 1;
		},
		SESSION_COOKIE_NAME: 'session',
		SESSION_COOKIE_OPTIONS: { path: '/' }
	}
});

const { migrate } = await import('../../server/migrations');
const { saveMemberProfile, readEditFields } = await import('../../server/member-edit');
const { getMemberById } = await import('../../server/members');

const EMAIL = 'imported@example.org';
const USER = { id: 'u1', email: EMAIL, subject: `email:${EMAIL}`, name: 'Imported', image: '' };
const NO_CHANGE = { checks: {}, other: '', publicProfile: true };
const ADMIN = { admin: true };
const ACTOR = { actorSubject: USER.subject, actorEmail: EMAIL };

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, $2)
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[GROUP.slug, GROUP.name]
	);
	GROUP.id = rows[0].id;
});
beforeEach(async () => {
	failMemberDelete = false;
	failAudit = false;
	revoked.length = 0;
	if (pool) await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

// A member as migration 13 leaves one the old sync imported: shared fields in
// data and the address in private_data.
async function imported(status = 'active'): Promise<string> {
	const data = { givenName: 'Ada', familyName: 'Byron', publicProfile: 'TRUE' };
	const { rows } = await pool!.query<{ id: string }>(
		`INSERT INTO member (group_id, email, name, data, private_data, status)
		 VALUES ($1, $2, 'Ada Byron', $3::jsonb, $4::jsonb, $5) RETURNING id`,
		[GROUP.id, EMAIL, JSON.stringify(data), JSON.stringify({ email: EMAIL }), status]
	);
	return rows[0].id;
}

test('a save of a sheet-imported member lands in Postgres', opts, async () => {
	const id = await imported();
	const n = await saveMemberProfile(
		GROUP,
		(await getMemberById(GROUP.id, id))!,
		{
			...NO_CHANGE,
			updates: { givenName: 'Augusta', familyName: 'Byron', handle: '' }
		},
		ACTOR,
		ADMIN
	);
	assert.equal(n, 1);
	const m = await getMemberById(GROUP.id, id);
	assert.equal(m?.name, 'Augusta Byron', 'the typed name was not derived from the saved fields');
	assert.equal(m?.data.publicProfile, 'TRUE');
});

// Loading every edit control and submitting them with one unrelated change must
// leave the typed columns as they were, however much of each is stored. A
// column with none of its fields stored (a sheet row that carried "Full Name")
// is the only one the form fills from the typed value, and that fill joins back
// to the same text.
const NEUTRAL: {
	label: string;
	data: Record<string, string>;
	typed: { name: string; city: string | null };
}[] = [
	{
		label: 'nothing stored behind any typed column',
		data: {},
		typed: { name: 'Augusta Ada King', city: 'London' }
	},
	{
		label: 'a name with one part stored',
		data: { givenName: 'Ada', city: 'London' },
		typed: { name: 'Ada Byron', city: 'London' }
	},
	{
		label: 'a typed column that disagrees with its stored fields',
		data: { givenName: 'Ada', familyName: 'Byron' },
		typed: { name: 'Augusta Ada King', city: null }
	}
];

for (const c of NEUTRAL) {
	test(`R8: an unrelated edit through the real form is neutral (${c.label})`, opts, async () => {
		const { rows } = await pool!.query<{ id: string }>(
			`INSERT INTO member (group_id, email, name, city, data, private_data)
			 VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb) RETURNING id`,
			[
				GROUP.id,
				EMAIL,
				c.typed.name,
				c.typed.city,
				JSON.stringify(c.data),
				JSON.stringify({ email: EMAIL })
			]
		);
		const member = (await getMemberById(GROUP.id, rows[0].id))!;
		// A links field posts its own controls, never a text value.
		const updates = Object.fromEntries(
			readEditFields(member)
				.filter((f) => !f.links)
				.map((f) => [f.name, f.value])
		);
		updates.bio = 'After';
		await saveMemberProfile(GROUP, member, { ...NO_CHANGE, updates }, ACTOR, ADMIN);
		const saved = (await getMemberById(GROUP.id, rows[0].id))!;
		assert.deepEqual({ name: saved.name, city: saved.city }, c.typed);
		assert.equal(saved.data.bio, 'After');
	});
}
