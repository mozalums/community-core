import assert from 'node:assert/strict';
import { register } from 'node:module';
import { after, before, beforeEach, mock, test } from 'node:test';
import { isRedirect } from '@sveltejs/kit';
import pg from 'pg';

// An address change end to end against a real Postgres: request, confirm,
// revert, through the real token store, session store, identity rewrite and
// confirm page. Redis and the mail transport are this file's own.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 4 }) : null;

process.env.LOREM_REDIS_PREFIX = 'f9pg';
delete process.env.ADDRESS_HEADER;
register(
	'data:text/javascript,' +
		encodeURIComponent(`
  const stubs = {
    '$env/dynamic/private': 'export const env = process.env;',
    '$env/dynamic/public': 'export const env = process.env;',
    '$app/environment': 'export const dev = false; export const browser = false; export const building = false;'
  };
  export async function resolve(specifier, context, next) {
    if (specifier in stubs) return {
      url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]),
      shortCircuit: true
    };
    return next(specifier, context);
  }`)
);

const kv = new Map<string, unknown>();
const sets = new Map<string, Set<string>>();
mock.module('$lib/server/redis', {
	namedExports: {
		redis: {
			get: async (k: string) => kv.get(k) ?? null,
			set: async (k: string, v: unknown) => (kv.set(k, structuredClone(v)), 'OK'),
			getdel: async (k: string) => {
				const v = kv.get(k) ?? null;
				kv.delete(k);
				return v;
			},
			del: async (...ks: string[]) => ks.forEach((k) => (kv.delete(k), sets.delete(k))),
			incr: async (k: string) => {
				const n = Number(kv.get(k) ?? 0) + 1;
				kv.set(k, n);
				return n;
			},
			expire: async () => 1,
			sadd: async (k: string, ...m: string[]) => {
				const s = sets.get(k) ?? new Set();
				m.forEach((x) => s.add(x));
				sets.set(k, s);
			},
			smembers: async (k: string) => [...(sets.get(k) ?? [])]
		}
	}
});
type Sent = { to: string[]; text?: string; tag: string };
const sent: Sent[] = [];
mock.module('$lib/server/mail', {
	namedExports: { sendMail: async (m: Sent) => void sent.push(m), mailConfigured: () => true }
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});
mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => pool,
		query: (text: string, values?: unknown[]) => pool!.query(text, values),
		withTransaction: async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
			const client = await pool!.connect();
			try {
				await client.query('BEGIN');
				const out = await fn(client);
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

const { migrate } = await import('./migrations');
const { requestEmailChange } = await import('./email-change');
const { issueMagicToken, peekMagicToken } = await import('./magic-link');
const { createSession, getSession, SESSION_TTL } = await import('./session-store');
const page = await import('../../routes/(auth)/auth/email/+page.server');

const OLD = 'f9-ada@example.org';
const NEW = 'f9-ada@new.example.org';
const OTHER = 'f9-bob@example.org';
const SLUGS = ['f9-one', 'f9-two'];
const ids = { groups: [] as string[], ada: [] as string[], bob: '' };

const settle = () => new Promise((r) => setImmediate(r));
const tokenIn = (m: Sent) => /token=([\w-]+)/.exec(m.text ?? '')![1];
const sessionFor = (email: string) =>
	createSession({
		user: { id: email, subject: `email:${email}`, email, name: '', image: '' },
		accessToken: '',
		idToken: '',
		expiresAt: Date.now() + SESSION_TTL * 1000,
		profile: {}
	});
// Ada has a passkey, so a change needs one used in the last ten minutes.
const ask = (next: string) =>
	requestEmailChange({
		session: {
			expiresAt: Date.now() + SESSION_TTL * 1000,
			auth: { method: 'passkey', at: Date.now() }
		},
		memberId: ids.ada[0],
		current: OLD,
		next,
		origin: 'https://www.example.org',
		ip: '203.0.113.7',
		returnTo: '/members'
	});
function formEvent(token: string, extra: Record<string, unknown> = {}) {
	const body = new FormData();
	body.set('token', token);
	return {
		request: new Request('https://www.example.org/auth/email', { method: 'POST', body }),
		url: new URL('https://www.example.org/auth/email'),
		...extra
	} as never;
}

// Where every row requirement 3 names stands for one address.
async function holdings(email: string) {
	const subject = `email:${email}`;
	const one = async (sql: string, v: unknown[]) =>
		(await pool!.query<{ n: number }>(sql, v)).rows[0].n;
	return {
		members: await one(
			`SELECT count(*)::int AS n FROM member WHERE email = $1 AND ident_subject = $2
			  AND group_id = ANY($3::uuid[])`,
			[email, subject, ids.groups]
		),
		admins: await one(
			`SELECT count(*)::int AS n FROM group_admin WHERE ident_subject = $1 AND email = $2
			  AND group_id = ANY($3::uuid[])`,
			[subject, email, ids.groups]
		),
		stars: await one(
			`SELECT count(*)::int AS n FROM member_star WHERE starrer = $1
			  AND group_id = ANY($2::uuid[])`,
			[subject, ids.groups]
		)
	};
}

async function cleanup() {
	await pool!.query(`DELETE FROM "group" WHERE slug = ANY($1)`, [SLUGS]);
	await pool!.query(
		`DELETE FROM audit_event WHERE action LIKE 'member.email-%'
		    AND (target_email = ANY($1) OR actor_email = ANY($1))`,
		[[OLD, NEW, 'f9-third@example.org']]
	);
	await pool!.query(`DELETE FROM email_revert_grant WHERE restore_to = ANY($1::citext[])`, [
		[OLD, NEW]
	]);
}

before(async () => {
	if (!pool) return;
	await migrate(pool);
	await cleanup();
});
beforeEach(async () => {
	if (!pool) return;
	await cleanup();
	kv.clear();
	sets.clear();
	sent.length = 0;
	ids.groups = [];
	ids.ada = [];
	for (const slug of SLUGS) {
		const { rows } = await pool.query<{ id: string }>(
			`INSERT INTO "group" (slug, name) VALUES ($1, $1) RETURNING id`,
			[slug]
		);
		ids.groups.push(rows[0].id);
	}
	// Ada belongs to both groups, admins the first, and stars Bob in both.
	for (const g of ids.groups) {
		const { rows } = await pool.query<{ id: string }>(
			`INSERT INTO member (group_id, email, ident_subject) VALUES ($1, $2, $3) RETURNING id`,
			[g, OLD, `email:${OLD}`]
		);
		ids.ada.push(rows[0].id);
		const bob = await pool.query<{ id: string }>(
			`INSERT INTO member (group_id, email) VALUES ($1, $2) RETURNING id`,
			[g, OTHER]
		);
		ids.bob = bob.rows[0].id;
		await pool.query(`INSERT INTO member_star (group_id, starrer, member_id) VALUES ($1, $2, $3)`, [
			g,
			`email:${OLD}`,
			bob.rows[0].id
		]);
	}
	await pool.query(`INSERT INTO group_admin (group_id, ident_subject, email) VALUES ($1, $2, $3)`, [
		ids.groups[0],
		`email:${OLD}`,
		OLD
	]);
	await pool.query(
		`INSERT INTO passkey_credential (id, member_id, public_key, device_type, nickname)
		 VALUES ('\\xf901', $1, '\\x02', 'singleDevice', 'Laptop')`,
		[ids.ada[0]]
	);
});
after(async () => {
	if (!pool) return;
	await cleanup();
	await pool.end();
});

test(
	'pg: F9 R3/R4/R5: request, confirm and revert move every identity row and back',
	opts,
	async () => {
		const before = await holdings(OLD);
		assert.deepEqual(before, { members: 2, admins: 1, stars: 2 });
		const oldSessions = [await sessionFor(OLD), await sessionFor(OLD)];

		assert.deepEqual(await ask(NEW), { ok: true });
		await settle();
		const confirm = sent.find((m) => m.tag === 'email-change')!;
		assert.deepEqual(confirm.to, [NEW]);

		const cookies: string[] = [];
		await assert.rejects(
			async () =>
				page.actions.confirm(
					formEvent(tokenIn(confirm), {
						cookies: { set: (_n: string, v: string) => cookies.push(v) }
					})
				),
			(e: unknown) => isRedirect(e) && e.location === '/members'
		);

		assert.deepEqual(await holdings(NEW), before, 'not every row moved to the new address');
		assert.deepEqual(await holdings(OLD), { members: 0, admins: 0, stars: 0 });
		for (const s of oldSessions) assert.equal(await getSession(s), null, 'an old session survived');
		assert.equal((await getSession(cookies[0]))?.user.subject, `email:${NEW}`);
		const keys = await pool!.query(
			`SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = $1`,
			[ids.ada[0]]
		);
		assert.equal(keys.rows[0].n, 1, 'a change by the member must leave their passkeys');

		const audit = await pool!.query<{
			actor_email: string;
			target_email: string;
			group_id: string;
		}>(
			`SELECT actor_email::text, target_email::text, group_id FROM audit_event
		  WHERE action = 'member.email-changed' AND target_email = $1 ORDER BY group_id`,
			[NEW]
		);
		assert.equal(audit.rows.length, 2, 'one audit row per group');
		for (const r of audit.rows) assert.deepEqual([r.actor_email, r.target_email], [OLD, NEW]);

		const notice = sent.find((m) => m.tag === 'email-changed')!;
		assert.deepEqual(notice.to, [OLD]);
		const newSession = cookies[0];
		const out = await page.actions.revert(formEvent(tokenIn(notice), { cookies: { delete() {} } }));
		assert.deepEqual(out, { reverted: true });

		assert.deepEqual(await holdings(OLD), before, 'not every row came back to the old address');
		assert.deepEqual(await holdings(NEW), { members: 0, admins: 0, stars: 0 });
		assert.equal(await getSession(newSession), null, 'the new address kept a session');
		const left = await pool!.query(
			`SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = ANY($1)`,
			[ids.ada]
		);
		assert.equal(left.rows[0].n, 0, 'a revert must remove the passkeys');
		const reverted = await pool!.query(
			`SELECT count(*)::int AS n FROM audit_event WHERE action = 'member.email-reverted' AND actor_email = $1`,
			[OLD]
		);
		assert.equal(reverted.rows[0].n, 2);
	}
);

test('pg: F9 R2/R5: a sign-in token is refused at confirm and nothing moves', opts, async () => {
	const signIn = await issueMagicToken({ email: NEW, from: OLD, callbackUrl: '/' } as never);
	const out = await page.actions.confirm(formEvent(signIn, { cookies: { set() {} } }));
	assert.equal((out as { status: number }).status, 400);
	assert.deepEqual(await holdings(OLD), { members: 2, admins: 1, stars: 2 });
	assert.ok(await peekMagicToken(signIn), 'the sign-in token was spent at the wrong door');
});

test('pg: F9 R1/R5: a taken address gets the same response as a free one', opts, async () => {
	const forTaken = await ask(OTHER);
	const forAdminOnly = await (async () => {
		await pool!.query(
			`INSERT INTO group_admin (group_id, ident_subject, email) VALUES ($1, $2, $3)`,
			[ids.groups[1], 'email:f9-admin@example.org', 'f9-admin@example.org']
		);
		return ask('f9-admin@example.org');
	})();
	const forFree = await ask(NEW);
	assert.deepEqual(forTaken, forFree);
	assert.deepEqual(forAdminOnly, forFree);
	await settle();
	assert.deepEqual(
		sent.map((m) => m.to[0]),
		[NEW],
		'a taken address was sent a confirm link'
	);
});

test('pg: F9 R3: a confirm whose address was taken meanwhile changes nothing', opts, async () => {
	await ask(NEW);
	await settle();
	const token = tokenIn(sent[0]);
	await pool!.query(`INSERT INTO member (group_id, email) VALUES ($1, $2)`, [ids.groups[1], NEW]);
	const out = await page.actions.confirm(formEvent(token, { cookies: { set() {} } }));
	assert.equal((out as { status: number }).status, 400);
	assert.deepEqual(await holdings(OLD), { members: 2, admins: 1, stars: 2 });
});



// Independent F9 review probes. Append unchanged to email-change.pg.test.ts.

test('review R1: a magic-link session cannot replace re-authentication by an enrolled passkey', opts, async () => {
  mock.module('$lib/server/gravatar', { namedExports: { refreshOnSignIn() {} } });
  const magicPage = await import('../../routes/(auth)/auth/magic/+page.server');
  const signIn = await issueMagicToken({ email: OLD, purpose: 'sign-in', callbackUrl: '/' });
  const cookies: string[] = [];
  await assert.rejects(
    async () => magicPage.actions.confirm(formEvent(signIn, {
      cookies: { set: (_n: string, value: string) => cookies.push(value) }
    })),
    (e: unknown) => isRedirect(e)
  );
  const session = await getSession(cookies[0]);
  assert.ok(session);
  const keys = await pool!.query('SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = $1', [ids.ada[0]]);
  assert.equal(keys.rows[0].n, 1);
  const result = await requestEmailChange({ session, memberId: ids.ada[0], current: OLD,
    next: NEW, origin: 'https://www.example.org', ip: '203.0.113.7', returnTo: '/' });
  await settle();
  assert.equal(result.ok, false, 'email-change accepted a magic-link session although the member has a passkey');
  assert.equal(sent.length, 0);
});

test('review R3: a pending confirmation cannot move a replacement member at a recycled address', opts, async () => {
  const { confirmEmailChange } = await import('./email-change');
  const third = 'f9-third@example.org';
  await ask(NEW);
  await ask(third);
  await settle();
  const first = tokenIn(sent.find(m => m.to[0] === NEW)!);
  const pending = tokenIn(sent.find(m => m.to[0] === third)!);
  assert.equal((await confirmEmailChange(first, 'https://www.example.org')).ok, true);
  const replacement = await pool!.query<{id: string}>(
    `INSERT INTO member (group_id, email, ident_subject, name) VALUES ($1, $2, $3, 'Replacement') RETURNING id`,
    [ids.groups[0], OLD, `email:${OLD}`]
  );
  const result = await confirmEmailChange(pending, 'https://www.example.org');
  const row = await pool!.query('SELECT email::text FROM member WHERE id = $1', [replacement.rows[0].id]);
  assert.deepEqual({ accepted: result.ok, replacementEmail: row.rows[0].email },
    { accepted: false, replacementEmail: OLD });
});

test('review R4: undo invalidates outstanding change authorizations from the compromised session', opts, async () => {
  const { confirmEmailChange, revertEmailChange } = await import('./email-change');
  const third = 'f9-third@example.org';
  await ask(NEW);
  await ask(third);
  await settle();
  const first = tokenIn(sent.find(m => m.to[0] === NEW)!);
  const pending = tokenIn(sent.find(m => m.to[0] === third)!);
  assert.equal((await confirmEmailChange(first, 'https://www.example.org')).ok, true);
  const undo = tokenIn(sent.find(m => m.tag === 'email-changed')!);
  assert.equal((await revertEmailChange(undo)).ok, true);
  const result = await confirmEmailChange(pending, 'https://www.example.org');
  assert.deepEqual({ accepted: result.ok, restored: await holdings(OLD) },
    { accepted: false, restored: { members: 2, admins: 1, stars: 2 } });
});

test('review R4: undo restores memberships added since confirmation and removes their passkeys', opts, async () => {
  const { confirmEmailChange, revertEmailChange } = await import('./email-change');
  await ask(NEW);
  await settle();
  assert.equal((await confirmEmailChange(tokenIn(sent[0]), 'https://www.example.org')).ok, true);
  const undo = tokenIn(sent.find(m => m.tag === 'email-changed')!);
  const g = await pool!.query<{id: string}>(`INSERT INTO "group" (slug, name) VALUES ('f9-review-three', 'Three') RETURNING id`);
  const groupId = g.rows[0].id;
  try {
    const added = await pool!.query<{id: string}>(
      `INSERT INTO member (group_id, email, ident_subject) VALUES ($1, $2, $3) RETURNING id`,
      [groupId, NEW, `email:${NEW}`]);
    const memberId = added.rows[0].id;
    await pool!.query(`INSERT INTO group_admin (group_id, email, ident_subject) VALUES ($1, $2, $3)`, [groupId, NEW, `email:${NEW}`]);
    await pool!.query(`INSERT INTO member_star (group_id, starrer, member_id) VALUES ($1, $2, $3)`, [groupId, `email:${NEW}`, memberId]);
    await pool!.query(`INSERT INTO passkey_credential (id, member_id, public_key, device_type, nickname)
      VALUES ('\\xf902', $1, '\\x02', 'singleDevice', 'After change')`, [memberId]);
    assert.equal((await revertEmailChange(undo)).ok, true);
    const member = (await pool!.query('SELECT email::text, ident_subject FROM member WHERE id = $1', [memberId])).rows[0];
    const keys = (await pool!.query('SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = $1', [memberId])).rows[0].n;
    const admin = (await pool!.query('SELECT email::text, ident_subject FROM group_admin WHERE group_id = $1', [groupId])).rows[0];
    const star = (await pool!.query('SELECT starrer FROM member_star WHERE group_id = $1', [groupId])).rows[0].starrer;
    assert.deepEqual({member, keys, admin, star}, {
      member: {email: OLD, ident_subject: `email:${OLD}`}, keys: 0,
      admin: {email: OLD, ident_subject: `email:${OLD}`}, star: `email:${OLD}`
    });
  } finally {
    await pool!.query('DELETE FROM "group" WHERE id = $1', [groupId]);
  }
});

test('review R1/R3: simultaneous confirmations cannot merge disjoint accounts onto one address', opts, async () => {
  const { moveIdentityIn } = await import('./email-change-core');
  await pool!.query('DELETE FROM member WHERE id = $1', [ids.ada[1]]);
  await pool!.query('DELETE FROM member WHERE group_id = $1 AND email = $2', [ids.groups[0], OTHER]);
  const alice = await pool!.connect();
  const bob = await pool!.connect();
  try {
    await alice.query('BEGIN');
    await bob.query('BEGIN');
    const first = await moveIdentityIn(alice as unknown as Parameters<typeof moveIdentityIn>[0], { memberIds: [ids.ada[0]], to: NEW,
      action: 'member.email-changed', actor: {actorEmail: OLD, actorSubject: `email:${OLD}`} });
    const secondPromise = moveIdentityIn(bob as unknown as Parameters<typeof moveIdentityIn>[0], { memberIds: [ids.bob], to: NEW,
      action: 'member.email-changed', actor: {actorEmail: OTHER, actorSubject: `email:${OTHER}`} });
    // Let a correct address-level lock block until Alice commits, without deadlocking this test.
    await new Promise(resolve => setTimeout(resolve, 150));
    await alice.query('COMMIT');
    const second = await secondPromise;
    await bob.query('COMMIT');
    assert.equal(first.ok, true);
    assert.equal(second.ok, false, 'both accounts moved to the same email across disjoint groups');
  } finally {
    await alice.query('ROLLBACK');
    await bob.query('ROLLBACK');
    alice.release();
    bob.release();
  }
});


test('review BRANCH-REGRESSION: changing sign-in email preserves the uploaded profile photo', opts, async () => {
  const { confirmEmailChange } = await import('./email-change');
  const { putAvatar, avatarIdFor } = await import('./avatars');
  const avatarId = await putAvatar(OLD, Buffer.from('uploaded-photo'), 'image/png');
  try {
    await ask(NEW);
    await settle();
    assert.equal((await confirmEmailChange(tokenIn(sent[0]), 'https://www.example.org')).ok, true);
    assert.equal(await avatarIdFor(NEW), avatarId, 'the profile lookup lost the uploaded photo after the email move');
  } finally {
    await pool!.query('DELETE FROM member_avatar WHERE email = ANY($1::citext[])', [[OLD, NEW]]);
  }
});

// A hijacker who changed A to B and then B to C holds the undo link for B;
// the owner holds the one for A.
async function chain(third: string) {
	const { confirmEmailChange } = await import('./email-change');
	const askFrom = (current: string, next: string) =>
		requestEmailChange({
			session: {
				expiresAt: Date.now() + SESSION_TTL * 1000,
				auth: { method: 'passkey', at: Date.now() }
			},
			memberId: ids.ada[0],
			current,
			next,
			origin: 'https://www.example.org',
			ip: '203.0.113.8',
			returnTo: '/'
		});
	const undoTo = (addr: string) => tokenIn(sent.find((m) => m.tag === 'email-changed' && m.to[0] === addr)!);
	await askFrom(OLD, NEW);
	await settle();
	assert.equal((await confirmEmailChange(tokenIn(sent.find((m) => m.to[0] === NEW)!), 'https://www.example.org')).ok, true);
	await askFrom(NEW, third);
	await settle();
	assert.equal((await confirmEmailChange(tokenIn(sent.find((m) => m.to[0] === third)!), 'https://www.example.org')).ok, true);
	return { owners: undoTo(OLD), hijackers: undoTo(NEW) };
}

test('pg: F9 R4: undoing a change voids the undo links of every later change', opts, async () => {
	const { revertEmailChange } = await import('./email-change');
	const { owners, hijackers } = await chain('f9-third@example.org');
	assert.deepEqual(await revertEmailChange(owners), { ok: true });
	assert.deepEqual(await revertEmailChange(hijackers), { ok: false, reason: 'token' });
	assert.deepEqual(await holdings(OLD), { members: 2, admins: 1, stars: 2 });
});

test('pg: F9 R4: a later undo link cannot void the owner\'s earlier one', opts, async () => {
	const { revertEmailChange } = await import('./email-change');
	const { owners, hijackers } = await chain('f9-third@example.org');
	assert.deepEqual(await revertEmailChange(hijackers), { ok: true });
	assert.deepEqual(await holdings(NEW), { members: 2, admins: 1, stars: 2 });
	assert.deepEqual(await revertEmailChange(owners), { ok: true });
	assert.deepEqual(await holdings(OLD), { members: 2, admins: 1, stars: 2 });
});

test('pg: F9 R6: operator recovery voids every outstanding undo link', opts, async () => {
	const { confirmEmailChange, revertEmailChange } = await import('./email-change');
	const { recoverIdentityIn } = await import('./email-change-core');
	const RESCUED = 'f9-rescued@example.org';
	await ask(NEW);
	await settle();
	assert.equal((await confirmEmailChange(tokenIn(sent[0]), 'https://www.example.org')).ok, true);
	const undo = tokenIn(sent.find((m) => m.tag === 'email-changed')!);
	const client = await pool!.connect();
	try {
		await client.query('BEGIN');
		const moved = await recoverIdentityIn(client as never, NEW, RESCUED);
		await client.query('COMMIT');
		assert.equal(moved.ok, true);
	} finally {
		client.release();
	}
	assert.deepEqual(await revertEmailChange(undo), { ok: false, reason: 'token' });
	assert.deepEqual(await holdings(RESCUED), { members: 2, admins: 1, stars: 2 });
	await pool!.query(`DELETE FROM audit_event WHERE target_email = $1`, [RESCUED]);
});

test('pg: F9 R3/R4: the uploaded photo follows the address out and back, over an orphan at the destination', opts, async () => {
	const { confirmEmailChange, revertEmailChange } = await import('./email-change');
	const { putAvatar, avatarIdFor } = await import('./avatars');
	const mine = await putAvatar(OLD, Buffer.from('mine'), 'image/png');
	const orphan = await putAvatar(NEW, Buffer.from('a former holder'), 'image/png');
	try {
		await ask(NEW);
		await settle();
		assert.equal((await confirmEmailChange(tokenIn(sent[0]), 'https://www.example.org')).ok, true);
		assert.equal(await avatarIdFor(NEW), mine);
		const left = await pool!.query(`SELECT count(*)::int AS n FROM member_avatar WHERE public_id = $1`, [orphan]);
		assert.equal(left.rows[0].n, 0, 'the orphaned photo outlived the move');
		assert.deepEqual(await revertEmailChange(tokenIn(sent.find((m) => m.tag === 'email-changed')!)), { ok: true });
		assert.equal(await avatarIdFor(OLD), mine);
		assert.equal(await avatarIdFor(NEW), null);
	} finally {
		await pool!.query('DELETE FROM member_avatar WHERE email = ANY($1::citext[])', [[OLD, NEW]]);
	}
});


// Independent F9 audit: concurrent writers and surviving account identity.
test('review R1/R3: a concurrent membership creation can claim the confirmation destination', opts, async () => {
  const { createMemberIn } = await import('./member-write-core');
  const { confirmChangeIn } = await import('./email-change-core');
  await pool!.query('DELETE FROM member WHERE id = $1', [ids.ada[1]]);
  const creator = await pool!.connect();
  const mover = await pool!.connect();
  try {
    await creator.query('BEGIN');
    await mover.query('BEGIN');
    await creator.query("SET LOCAL statement_timeout = '5s'");
    await mover.query("SET LOCAL statement_timeout = '5s'");
    const claimed = await createMemberIn(creator, {
      group: { id: ids.groups[1], slug: SLUGS[1] }, email: NEW, values: {},
      actor: { actorEmail: OTHER, actorSubject: `email:${OTHER}` }, recordPrivateValues: false
    });
    assert.ok(claimed);
    const pending = confirmChangeIn(mover as never, {
      memberId: ids.ada[0], epoch: '0', from: OLD, to: NEW, revertTtlSeconds: 604800
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    await creator.query('COMMIT');
    const result = await pending;
    await mover.query('COMMIT');
    assert.deepEqual({accepted: result.ok, old: await holdings(OLD), destination: await holdings(NEW)}, {
      accepted: false, old: {members: 1, admins: 1, stars: 2},
      destination: {members: 0, admins: 0, stars: 0}
    }, 'confirmation merged onto the address being claimed by an independent membership writer');
  } finally {
    await creator.query('ROLLBACK');
    await mover.query('ROLLBACK');
    creator.release();
    mover.release();
  }
});

test('review R4: undo still reaches the account after its original memberships are deleted', opts, async () => {
  const { confirmEmailChange, revertEmailChange } = await import('./email-change');
  const { createMemberIn, hardPurgeMemberIn } = await import('./member-write-core');
  await ask(NEW);
  await settle();
  assert.equal((await confirmEmailChange(tokenIn(sent[0]), 'https://www.example.org')).ok, true);
  const undo = tokenIn(sent.find(m => m.tag === 'email-changed')!);
  const {rows: [g]} = await pool!.query(`INSERT INTO "group" (slug, name) VALUES ('f9-root-survivor', 'Survivor') RETURNING id`);
  const c = await pool!.connect();
  try {
    await c.query('BEGIN');
    const actor = {actorEmail: NEW, actorSubject: `email:${NEW}`};
    const added = await createMemberIn(c, {
      group: {id: g.id, slug: 'f9-root-survivor'}, email: NEW, values: {}, actor, recordPrivateValues: false
    });
    assert.ok(added);
    await c.query(`UPDATE member SET ident_subject = $2 WHERE id = $1`, [added, `email:${NEW}`]);
    await c.query(`INSERT INTO passkey_credential (id, member_id, public_key, device_type, nickname)
      VALUES ('\\xf903', $1, '\\x02', 'singleDevice', 'Surviving key')`, [added]);
    for (let i = 0; i < ids.ada.length; i++) {
      await hardPurgeMemberIn(c, {group: {id: ids.groups[i], slug: SLUGS[i]}, memberId: ids.ada[i], actor});
    }
    await c.query('COMMIT');
    const out = await revertEmailChange(undo);
    const member = (await c.query('SELECT email::text, ident_subject FROM member WHERE id = $1', [added])).rows[0];
    const keys = (await c.query('SELECT count(*)::int AS n FROM passkey_credential WHERE member_id = $1', [added])).rows[0].n;
    assert.deepEqual({out, member, keys}, {
      out: {ok: true}, member: {email: OLD, ident_subject: `email:${OLD}`}, keys: 0
    }, 'undo lost its account when the memberships recorded in its grant were removed');
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await pool!.query('DELETE FROM "group" WHERE id = $1', [g.id]);
  }
});

// Every other writer that can put an address on a row: an admin grant and a
// roster import, each in a group the moving account is not in.
async function raceAgainstMove(claim: (c: pg.PoolClient) => Promise<unknown>) {
	const { confirmChangeIn } = await import('./email-change-core');
	await pool!.query('DELETE FROM member WHERE id = $1', [ids.ada[1]]);
	const claimer = await pool!.connect();
	const mover = await pool!.connect();
	try {
		await claimer.query('BEGIN');
		await mover.query('BEGIN');
		await claimer.query("SET LOCAL statement_timeout = '5s'");
		await mover.query("SET LOCAL statement_timeout = '5s'");
		await claim(claimer);
		const pending = confirmChangeIn(mover as never, {
			memberId: ids.ada[0], epoch: '0', from: OLD, to: NEW, revertTtlSeconds: 604800
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		await claimer.query('COMMIT');
		const result = await pending;
		await mover.query('COMMIT');
		return { result, old: await holdings(OLD) };
	} finally {
		await claimer.query('ROLLBACK');
		await mover.query('ROLLBACK');
		claimer.release();
		mover.release();
	}
}
test('pg: F9 R1/R3: an admin grant racing a confirm keeps the destination with the grantee', opts, async () => {
	const { grantGroupAdmin } = await import('./groups');
	const out = await raceAgainstMove((c) => grantGroupAdmin(c, ids.groups[1], `email:${NEW}`, NEW));
	assert.deepEqual(out, { result: { ok: false, reason: 'taken' }, old: { members: 1, admins: 1, stars: 2 } });
});
test('pg: F9 R1/R3: a roster import racing a confirm keeps the destination with the import', opts, async () => {
	const { lockGroupIn, importInsertIn } = await import('./member-write-core');
	const out = await raceAgainstMove(async (c) => {
		const lock = await lockGroupIn(c as never, ids.groups[1]);
		await importInsertIn(lock, ids.groups[1], NEW, {
			data: {}, privateData: {}, name: 'Imported', city: null, linkedin: null
		});
	});
	assert.deepEqual(out, { result: { ok: false, reason: 'taken' }, old: { members: 1, admins: 1, stars: 2 } });
});
