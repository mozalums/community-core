import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import pg from 'pg';

// Profile save and delete against a real Postgres, the only roster: a delete
// reports success only once the member row is gone. It runs on the default
// skin; a name in two parts is in src/lib/skin/every-role/member-edit.pg.test.ts.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 6 }) : null;

let failMemberDelete = false;
let failAudit = false;
let failRevoke = false;
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
	slug: 'f04-member-edit',
	name: 'F04 edit',
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
			if (failRevoke) throw new Error('redis down');
			revoked.push(subject);
			return 1;
		},
		SESSION_COOKIE_NAME: 'session',
		SESSION_COOKIE_OPTIONS: { path: '/' }
	}
});

const { migrate } = await import('./migrations');
const { saveMemberProfile, readEditFields } = await import('./member-edit');
const { getMemberById, resolveMember } = await import('./members');
const { actions } = await import('../../routes/group/[slug]/members/[id]/edit/+page.server');
const { purgedTarget } = await import('./member-removal');

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
	failRevoke = false;
	revoked.length = 0;
	if (pool) await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

// A member as an import leaves one: shared fields in data, nothing private.
async function imported(status = 'active'): Promise<string> {
	const data = { name: 'Ada Byron', country: 'UK' };
	const { rows } = await pool!.query<{ id: string }>(
		`INSERT INTO member (group_id, email, name, data, private_data, status)
		 VALUES ($1, $2, 'Ada Byron', $3::jsonb, $4::jsonb, $5) RETURNING id`,
		[GROUP.id, EMAIL, JSON.stringify(data), JSON.stringify({}), status]
	);
	return rows[0].id;
}

type Outcome = { status?: number; data?: { deleteError?: string } };
async function deleteAction(id: string): Promise<Outcome> {
	const href = `https://example.org/group/${GROUP.slug}/members/${id}/edit`;
	const event = {
		params: { slug: GROUP.slug, id },
		locals: { user: USER },
		url: new URL(href),
		request: new Request(href, { method: 'POST', body: new FormData() }),
		cookies: { get: () => undefined, delete: () => {} }
	};
	try {
		return (await actions.delete!(event as never)) as Outcome;
	} catch (e) {
		if ((e as Outcome).status === 303) return e as Outcome;
		throw e;
	}
}

test('a save of a sheet-imported member lands in Postgres', opts, async () => {
	const id = await imported();
	const n = await saveMemberProfile(
		GROUP,
		(await getMemberById(GROUP.id, id))!,
		{
			...NO_CHANGE,
			updates: { name: 'Augusta Byron', country: 'UK', bio: '' }
		},
		ACTOR,
		ADMIN
	);
	assert.equal(n, 1);
	const m = await getMemberById(GROUP.id, id);
	assert.equal(m?.name, 'Augusta Byron', 'the typed name was not derived from the saved fields');
	assert.equal(m?.data.country, 'UK');
});

test('two concurrent saves of different fields both land', opts, async () => {
	const id = await imported();
	const stale = (await getMemberById(GROUP.id, id))!;
	await Promise.all([
		saveMemberProfile(GROUP, stale, { ...NO_CHANGE, updates: { city: 'London' } }, ACTOR, ADMIN),
		saveMemberProfile(GROUP, stale, { ...NO_CHANGE, updates: { bio: 'enchantress' } }, ACTOR, ADMIN)
	]);
	const m = await getMemberById(GROUP.id, id);
	assert.equal(m?.data.city, 'London');
	assert.equal(m?.data.bio, 'enchantress');
});

test('saving a profile deleted after the form rendered creates nothing', opts, async () => {
	const id = await imported();
	const stale = (await getMemberById(GROUP.id, id))!;
	await pool!.query('DELETE FROM member WHERE id = $1', [id]);
	await assert.rejects(() =>
		saveMemberProfile(GROUP, stale, { ...NO_CHANGE, updates: { name: 'Ghost' } }, ACTOR, ADMIN)
	);
	const n = await pool!.query('SELECT count(*)::int AS n FROM member WHERE group_id = $1', [
		GROUP.id
	]);
	assert.equal(n.rows[0].n, 0);
});

test('a failed member delete revokes nothing and can be retried', opts, async () => {
	const id = await imported();
	failMemberDelete = true;
	const first = await deleteAction(id);
	assert.equal(first.status, 500);
	assert.deepEqual(revoked, [], 'sessions were revoked for a member who is still active');
	assert.ok(await getMemberById(GROUP.id, id));

	failMemberDelete = false;
	const retry = await deleteAction(id);
	assert.equal(retry.status, 303);
	assert.equal(await getMemberById(GROUP.id, id), null);
});

test('a deletion removes the member and revokes their sessions', opts, async () => {
	const id = await imported();
	const out = await deleteAction(id);
	assert.equal(out.status, 303, JSON.stringify(out));
	assert.equal(await getMemberById(GROUP.id, id), null);
	assert.ok(revoked.includes(`email:${EMAIL}`), 'sessions were not revoked');
});

test('E32 R6: a revocation that fails after the purge is retried from the audit row, until the address rejoins', opts, async () => {
	const id = await imported();
	failRevoke = true;
	const first = await deleteAction(id);
	assert.equal(first.status, 500);
	assert.equal(await getMemberById(GROUP.id, id), null);
	assert.deepEqual(await purgedTarget(GROUP.id, id), { email: EMAIL, identSubject: null });

	failRevoke = false;
	const retry = await deleteAction(id);
	assert.equal(retry.status, 303, JSON.stringify(retry));
	assert.ok(revoked.includes(`email:${EMAIL}`));

	await imported();
	assert.equal(await purgedTarget(GROUP.id, id), null, 'a retry would reach the new member');
});

// The completion row is written first inside the cleanup transaction, so a
// failed INSERT leaves the requester signed in. A failure at COMMIT comes after
// the sessions are revoked; a deferred trigger is how PostgreSQL produces one.
test('E32 R6: a completion that fails at commit, after the sessions are gone, stays pending and reachable through sign-in', opts, async () => {
	const removal = await import('../../routes/group/[slug]/removal/[id]/+page.server');
	const id = await imported();
	await pool!.query(`CREATE FUNCTION e32_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF NEW.action = 'member.removal-completed' THEN RAISE EXCEPTION 'commit rejected'; END IF;
			RETURN NULL;
		END $$`);
	await pool!.query(`CREATE CONSTRAINT TRIGGER e32_commit_reject AFTER INSERT ON audit_event
		DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION e32_commit_reject()`);
	try {
		const first = await deleteAction(id);
		assert.equal(first.status, 500, JSON.stringify(first));
		assert.ok(revoked.includes(`email:${EMAIL}`), 'the failure did not come after revocation');
		assert.deepEqual(await purgedTarget(GROUP.id, id), { email: EMAIL, identSubject: null });

		const path = `/group/${GROUP.slug}/removal/${id}`;
		const view = async (user: typeof USER | null): Promise<unknown> => {
			const url = new URL(`https://example.org${path}`);
			try {
				return await removal.load({ params: { slug: GROUP.slug, id }, locals: { user }, url } as never);
			} catch (e) {
				return e;
			}
		};
		const guest = (await view(null)) as { status?: number; location?: string };
		assert.equal(guest.status, 303);
		assert.equal(guest.location, `/login?callbackUrl=${encodeURIComponent(path)}`);
		assert.deepEqual(await view(USER), {}, 'signing in again does not reach recovery');
	} finally {
		await pool!.query('DROP TRIGGER e32_commit_reject ON audit_event');
		await pool!.query('DROP FUNCTION e32_commit_reject()');
	}
	const retry = await deleteAction(id);
	assert.equal(retry.status, 303, JSON.stringify(retry));
	assert.equal(await purgedTarget(GROUP.id, id), null, 'the retry did not record completion');
});

async function audits(id: string) {
	const { rows } = await pool!.query(
		'SELECT action, before, after, meta FROM audit_event WHERE target_id = $1 ORDER BY at',
		[id]
	);
	return rows;
}

test('a private field change is audited as set/empty, never its value', opts, async () => {
	const id = await imported();
	await saveMemberProfile(
		GROUP,
		(await getMemberById(GROUP.id, id))!,
		{ ...NO_CHANGE, updates: { phone: '555 0100', bio: 'ada' } },
		ACTOR,
		ADMIN
	);
	const [e] = await audits(id);
	assert.equal(e.action, 'member.updated');
	assert.doesNotMatch(JSON.stringify(e), /555 0100/, 'the private value reached the audit row');
	assert.equal(e.after.phone, '<set>');
	assert.equal(e.before.phone, '<empty>');
	assert.equal(e.after.bio, 'ada');
	assert.deepEqual(e.meta.redacted, ['phone']);
	const m = await getMemberById(GROUP.id, id);
	assert.equal(m?.privateData.phone, '555 0100', 'the private value was not stored privately');
	assert.equal(m?.data.phone, undefined, 'the private value landed in searchable data');
});

test('a save that changes nothing writes no audit row', opts, async () => {
	const id = await imported();
	const n = await saveMemberProfile(
		GROUP,
		(await getMemberById(GROUP.id, id))!,
		{ ...NO_CHANGE, updates: { name: 'Ada Byron' } },
		ACTOR,
		ADMIN
	);
	assert.equal(n, 0);
	assert.deepEqual(await audits(id), []);
});

test('a second delete of the same member succeeds without a second audit row', opts, async () => {
	const id = await imported();
	const { hardPurgeMember } = await import('./member-write');
	assert.equal(await hardPurgeMember(GROUP, id, ACTOR), true);
	assert.equal(await hardPurgeMember(GROUP, id, ACTOR), false);
	const rows = await audits(id);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].action, 'member.deleted');
});

// Loading every edit control and submitting them with one unrelated change must
// leave the typed columns as they were, however much of each is stored. A
// column with none of its fields stored (a sheet row that carried "Full Name")
// is the only one the form fills from the typed value, and that fill joins back
// to the same text. A typed column no field of the skin names (linkedin here)
// is never rebuilt.
const NEUTRAL: {
	label: string;
	data: Record<string, string>;
	typed: { name: string; city: string | null; linkedin: string | null };
}[] = [
	{
		label: 'nothing stored behind any typed column',
		data: {},
		typed: { name: 'Augusta Ada King', city: 'London', linkedin: 'https://l.example/ada' }
	},
	{
		label: 'one typed column stored and another not',
		data: { city: 'London' },
		typed: { name: 'Ada Byron', city: 'London', linkedin: null }
	},
	{
		label: 'a typed column that disagrees with its stored fields',
		data: { name: 'Ada Byron' },
		typed: { name: 'Augusta Ada King', city: null, linkedin: null }
	}
];

for (const c of NEUTRAL) {
	test(`R8: an unrelated edit through the real form is neutral (${c.label})`, opts, async () => {
		const { rows } = await pool!.query<{ id: string }>(
			`INSERT INTO member (group_id, email, name, city, linkedin, data, private_data)
			 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) RETURNING id`,
			[
				GROUP.id,
				EMAIL,
				c.typed.name,
				c.typed.city,
				c.typed.linkedin,
				JSON.stringify(c.data),
				JSON.stringify({})
			]
		);
		const member = (await getMemberById(GROUP.id, rows[0].id))!;
		const updates = Object.fromEntries(readEditFields(member).map((f) => [f.name, f.value]));
		updates.bio = 'After';
		await saveMemberProfile(GROUP, member, { ...NO_CHANGE, updates }, ACTOR, ADMIN);
		const saved = (await getMemberById(GROUP.id, rows[0].id))!;
		assert.deepEqual({ name: saved.name, city: saved.city, linkedin: saved.linkedin }, c.typed);
		assert.equal(saved.data.bio, 'After');
	});
}

test(
	'R10: a first-login bind commits with its audit row, once, and not at all when the audit fails',
	opts,
	async () => {
		const { rows } = await pool!.query<{ id: string }>(
			`INSERT INTO member (group_id, email, data, status) VALUES ($1, $2, '{}', 'active') RETURNING id`,
			[GROUP.id, EMAIL]
		);
		const id = rows[0].id;
		const bound = async () =>
			(await pool!.query(`SELECT ident_subject FROM member WHERE id = $1`, [id])).rows[0]
				.ident_subject;
		const audits = async () =>
			Number(
				(
					await pool!.query(
						`SELECT count(*) FROM audit_event WHERE action = 'member.identity-bound' AND target_id = $1`,
						[id]
					)
				).rows[0].count
			);

		failAudit = true;
		const refused = await resolveMember(GROUP.id, EMAIL, 'oidc:first');
		assert.equal(refused.member?.id, id, 'email fallback still admits the member');
		assert.equal(refused.firstLogin, false);
		assert.equal(await bound(), null, 'a bind whose audit failed was committed');
		assert.equal(await audits(), 0);

		failAudit = false;
		assert.equal((await resolveMember(GROUP.id, EMAIL, 'oidc:first')).firstLogin, true);
		assert.equal(await bound(), 'oidc:first');
		assert.equal(await audits(), 1);

		assert.equal((await resolveMember(GROUP.id, EMAIL, 'oidc:first')).firstLogin, false);
		assert.equal(await audits(), 1, 'a later login re-audited the bind');
	}
);
