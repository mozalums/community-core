import assert from 'node:assert/strict';
import { register } from 'node:module';
import { beforeEach, mock, test } from 'node:test';
import { isHttpError, isRedirect } from '@sveltejs/kit';

// The member's own address change, through the real token store, session
// store and routes. Redis and the mail transport are this file's own; the
// Postgres rewrite is ./email-change-core, stubbed here to record what it was
// asked to do and driven against a real database in email-change.pg.test.ts.

process.env.LOREM_REDIS_PREFIX = 'f9test';
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
const ttl = new Map<string, number>();
const sets = new Map<string, Set<string>>();
const redis = {
	get: async (k: string) => kv.get(k) ?? null,
	set: async (k: string, v: unknown, o?: { ex?: number }) => {
		kv.set(k, structuredClone(v));
		if (o?.ex) ttl.set(k, o.ex);
		return 'OK';
	},
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
};
mock.module('$lib/server/redis', { namedExports: { redis } });

type Sent = { to: string[]; subject: string; text?: string; tag: string };
const sent: Sent[] = [];
mock.module('$lib/server/mail', {
	namedExports: {
		sendMail: async (m: Sent) => void sent.push(m),
		mailConfigured: () => true
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

// ---- The identity rewrite, recorded rather than run.
const taken = new Set<string>();
const moves: Record<string, unknown>[] = [];
let moveResult: { ok: true; from: string[]; memberIds: string[] } | { ok: false; reason: string } =
	{ ok: true, from: [], memberIds: [] };
let identity = { email: 'ada@example.org', epoch: '7', ids: ['m1', 'm2'], passkeys: 0 };
const normalizeEmail = (e: string) => e.trim().toLowerCase();
mock.module('$lib/server/email-change-core', {
	namedExports: {
		normalizeEmail,
		isValidEmail: (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e),
		subjectFor: (e: string) => `email:${normalizeEmail(e)}`,
		addressTakenIn: async (_c: unknown, e: string) => taken.has(e),
		readIdentityIn: async () => identity,
		confirmChangeIn: async (_c: unknown, c: Record<string, unknown>) => {
			moves.push(c);
			return moveResult.ok ? { ...moveResult, grant: 'g1' } : moveResult;
		},
		revertGrantIn: async (_c: unknown, grant: string) => {
			moves.push({ grant });
			return moveResult;
		},
		IdentityShifted: class extends Error {}
	}
});
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async () => ({ rows: [], rowCount: 0 }),
		withTransaction: async <T>(fn: (c: unknown) => Promise<T>) => fn({})
	}
});

const { requestEmailChange, confirmEmailChange, revertEmailChange, REVERT_TTL } =
	await import('./email-change');
const { consumeMagicToken, issueMagicToken, peekMagicToken, sendMagicLink } =
	await import('./magic-link');
const { createSession, getSession, SESSION_TTL } = await import('./session-store');
const route = await import('../../routes/(auth)/auth/email/+page.server');

const OLD = 'ada@example.org';
const NEW = 'ada@new.example.org';
const fresh = () => ({ expiresAt: Date.now() + SESSION_TTL * 1000 });
const stale = () => ({ expiresAt: Date.now() + SESSION_TTL * 1000 - 11 * 60 * 1000 });
const ask = (over: Partial<Parameters<typeof requestEmailChange>[0]> = {}) =>
	requestEmailChange({
		session: fresh(),
		memberId: 'm1',
		current: OLD,
		next: NEW,
		origin: 'https://www.example.org',
		ip: '203.0.113.9',
		returnTo: '/members/m1/edit',
		...over
	});
const settle = () => new Promise((r) => setImmediate(r));
const tokenIn = (m: Sent) => /token=([\w-]+)/.exec(m.text ?? '')![1];
const sessionFor = (subject: string) =>
	createSession({
		user: { id: subject, subject, email: subject.slice(6), name: '', image: '' },
		accessToken: '',
		idToken: '',
		expiresAt: Date.now() + SESSION_TTL * 1000,
		profile: {}
	});

beforeEach(() => {
	kv.clear();
	ttl.clear();
	sets.clear();
	sent.length = 0;
	moves.length = 0;
	taken.clear();
	moveResult = { ok: true, from: [OLD], memberIds: ['m1', 'm2'] };
	identity = { email: OLD, epoch: '7', ids: ['m1', 'm2'], passkeys: 0 };
});

// ---- 1

test('F9 R1: a change needs a session minted in the last ten minutes', async () => {
	assert.deepEqual(await ask({ session: stale() }), { ok: false, reason: 'stale' });
	assert.deepEqual(await ask({ session: null }), { ok: false, reason: 'stale' });
	await settle();
	assert.equal(sent.length, 0);
	assert.deepEqual(await ask(), { ok: true });
});

test('F9 R1: an account with a passkey needs a passkey sign-in from the last ten minutes', async () => {
	identity = { ...identity, passkeys: 1 };
	const at = (method: 'magic-link' | 'passkey', ago: number) => ({
		...fresh(),
		auth: { method, at: Date.now() - ago }
	});
	assert.deepEqual(await ask({ session: at('magic-link', 0) }), { ok: false, reason: 'passkey' });
	assert.deepEqual(await ask({ session: fresh() }), { ok: false, reason: 'passkey' });
	assert.deepEqual(await ask({ session: at('passkey', 11 * 60 * 1000) }), {
		ok: false,
		reason: 'passkey'
	});
	await settle();
	assert.equal(sent.length, 0);
	assert.deepEqual(await ask({ session: at('passkey', 9 * 60 * 1000) }), { ok: true });
});

test('F9 R1: with no usable passkey, a fresh magic-link sign-in is enough', async () => {
	const { reauthState } = await import('./passkeys');
	const now = Date.now();
	const minted = (ago: number) => ({
		expiresAt: now - ago + SESSION_TTL * 1000,
		auth: { method: 'magic-link' as const, at: now - ago }
	});
	// passkeyRequired is false both with none enrolled and with auth.passkeys off.
	assert.equal(reauthState(minted(10 * 60 * 1000), false, now), 'ok');
	assert.equal(reauthState(minted(10 * 60 * 1000 + 1), false, now), 'stale');
	assert.equal(reauthState(minted(0), true, now), 'passkey');
	const passkey = { ...minted(10 * 60 * 1000), auth: { method: 'passkey' as const, at: now - 10 * 60 * 1000 } };
	assert.equal(reauthState(passkey, true, now), 'ok');
	assert.equal(reauthState({ ...passkey, auth: { ...passkey.auth, at: passkey.auth.at - 1 } }, true, now), 'passkey');
});

test('F9 R1: the new address must be valid and differ from the current one', async () => {
	assert.deepEqual(await ask({ next: 'not-an-address' }), { ok: false, reason: 'invalid' });
	assert.deepEqual(await ask({ next: ' ADA@example.org ' }), { ok: false, reason: 'same' });
	await settle();
	assert.equal(sent.length, 0);
});

test('F9 R1: a taken address gets the same response as a free one, and no mail', async () => {
	taken.add('taken@example.org');
	const forTaken = await ask({ next: 'taken@example.org' });
	const forFree = await ask({ next: 'free@example.org' });
	assert.deepEqual(forTaken, forFree);
	await settle();
	assert.deepEqual(
		sent.map((m) => m.to),
		[['free@example.org']]
	);
});

test('F9 R1: the endpoint refuses anyone but the profile owner', async () => {
	mock.module('$lib/server/groups', {
		namedExports: { getGroupBySlug: async () => ({ id: 'g1', slug: 'a' }) }
	});
	mock.module('$lib/server/members', {
		namedExports: {
			getMemberById: async () => ({ id: 'm1', email: OLD, identSubject: `email:${OLD}` }),
			canEditMember: (m: { email: string }, u: { email: string } | null, admin: boolean) =>
				admin || u?.email === m.email
		}
	});
	const { POST } = await import('../../routes/group/[slug]/members/[id]/email/+server');
	const event = (
		user: { email: string; subject: string },
		id = '00000000-0000-4000-8000-000000000001'
	) =>
		({
			params: { slug: 'a', id },
			locals: { user, session: fresh() },
			request: new Request('https://www.example.org/x', {
				method: 'POST',
				body: JSON.stringify({ email: NEW })
			}),
			url: new URL('https://www.example.org/x'),
			getClientAddress: () => '203.0.113.9'
		}) as never;
	await assert.rejects(
		async () => POST(event({ email: 'admin@example.org', subject: 'email:admin@example.org' })),
		(e: unknown) => isHttpError(e) && e.status === 403
	);
	const res = await POST(event({ email: OLD, subject: `email:${OLD}` }));
	assert.equal(res.status, 200);
});

// The edit page builds the endpoint from memberRef, which is the username once
// the member has chosen one (F11).
test('F9 R1: the endpoint answers at the username URL, and a stranger there gets 404', async () => {
	const { POST } = await import('../../routes/group/[slug]/members/[id]/email/+server');
	const event = (user: { email: string; subject: string }) =>
		({
			params: { slug: 'a', id: 'old-name' },
			locals: { user, session: fresh() },
			request: new Request('https://www.example.org/x', {
				method: 'POST',
				body: JSON.stringify({ email: NEW })
			}),
			url: new URL('https://www.example.org/x'),
			getClientAddress: () => '203.0.113.9'
		}) as never;
	const res = await POST(event({ email: OLD, subject: `email:${OLD}` }));
	assert.equal(res.status, 200);
	await assert.rejects(
		async () => POST(event({ email: 'admin@example.org', subject: 'email:admin@example.org' })),
		(e: unknown) => isHttpError(e) && e.status === 404
	);
});

// ---- 2

test('F9 R2: the confirm link goes to the new address, single-use, for 30 minutes', async () => {
	await ask();
	await settle();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0].to, [NEW]);
	assert.equal(sent[0].tag, 'email-change');
	const token = tokenIn(sent[0]);
	const payload = await peekMagicToken(token, 'email-change');
	assert.equal(payload?.purpose, 'email-change');
	assert.equal(payload?.from, OLD);
	assert.equal([...ttl.values()].includes(30 * 60), true);

	assert.equal((await confirmEmailChange(token, 'https://www.example.org')).ok, true);
	assert.deepEqual(await confirmEmailChange(token, 'https://www.example.org'), {
		ok: false,
		reason: 'token'
	});
});

test('F9 R2: a sign-in token cannot confirm a change, and is not spent trying', async () => {
	await sendMagicLink({ email: OLD, origin: 'https://www.example.org', ip: '203.0.113.9' });
	const signIn = tokenIn(sent[0]);
	assert.deepEqual(await confirmEmailChange(signIn, 'https://www.example.org'), {
		ok: false,
		reason: 'token'
	});
	assert.equal(moves.length, 0);
	assert.equal((await consumeMagicToken(signIn))?.email, OLD, 'the sign-in link stopped working');
});

test('F9 R2: a change token cannot sign anyone in, and a revert token cannot confirm', async () => {
	await ask();
	await settle();
	const change = tokenIn(sent[0]);
	assert.equal(await consumeMagicToken(change), null);
	const res = await route.load({ url: new URL(`https://x/auth/magic?token=${change}`) } as never);
	assert.equal((res as { kind: string }).kind, 'change');
	const magicPage = await import('../../routes/(auth)/auth/magic/+page.server');
	assert.deepEqual(
		await magicPage.load({ url: new URL(`https://x/auth/magic?token=${change}`) } as never),
		{ valid: false }
	);

	const revert = await issueMagicToken({
		purpose: 'email-revert',
		email: OLD,
		grant: 'g1',
		callbackUrl: '/'
	});
	assert.deepEqual(await confirmEmailChange(revert, 'https://x'), { ok: false, reason: 'token' });
	assert.deepEqual(await revertEmailChange(change), { ok: false, reason: 'token' });
});

test('F9 R2: change requests spend the magic link per-address and per-IP limits', async () => {
	for (let i = 0; i < 5; i++) await ask();
	await settle();
	assert.equal(sent.length, 5);
	assert.deepEqual(await ask(), { ok: true }, 'a limited request answers like any other');
	await settle();
	assert.equal(sent.length, 5, 'the sixth request to one address in the window sent mail');

	sent.length = 0;
	for (let i = 0; i < 20; i++) await ask({ next: `n${i}@example.org`, ip: '198.51.100.1' });
	await ask({ next: 'n20@example.org', ip: '198.51.100.1' });
	await settle();
	assert.equal(sent.length, 20, 'the per-IP cap did not apply');
});

// ---- 3

test('F9 R3: confirming moves every row of the address and revokes the old subject', async () => {
	const other = await sessionFor(`email:${OLD}`);
	await ask();
	await settle();
	const token = tokenIn(sent[0]);
	const cookies: { name: string; value: string }[] = [];
	const form = new FormData();
	form.set('token', token);
	await assert.rejects(
		async () =>
			route.actions.confirm({
				request: new Request('https://www.example.org/auth/email?/confirm', {
					method: 'POST',
					body: form
				}),
				cookies: { set: (name: string, value: string) => cookies.push({ name, value }) },
				url: new URL('https://www.example.org/auth/email')
			} as never),
		(e: unknown) => isRedirect(e) && e.location === '/members/m1/edit'
	);
	assert.deepEqual(moves[0], {
		memberId: 'm1',
		epoch: '7',
		from: OLD,
		to: NEW,
		revertTtlSeconds: REVERT_TTL
	});
	assert.equal(await getSession(other), null, 'a session under the old subject survived');
	assert.equal(cookies.length, 1);
	const minted = await getSession(cookies[0].value);
	assert.equal(minted?.user.subject, `email:${NEW}`);
});

// ---- 4

test('F9 R4: the old address gets a notice whose undo link lasts 7 days', async () => {
	await ask();
	await settle();
	await confirmEmailChange(tokenIn(sent[0]), 'https://www.example.org');
	const notice = sent.find((m) => m.tag === 'email-changed')!;
	assert.deepEqual(notice.to, [OLD]);
	assert.match(notice.text!, new RegExp(NEW.replace(/\./g, '\\.')));
	const revert = tokenIn(notice);
	const payload = await peekMagicToken(revert, 'email-revert');
	assert.equal(payload?.grant, 'g1');
	assert.equal(payload?.email, OLD);
	assert.equal(REVERT_TTL, 7 * 24 * 60 * 60);
	assert.equal([...ttl.values()].includes(REVERT_TTL), true);
});

test('F9 R4: reverting restores the address, removes passkeys and revokes every session', async () => {
	const onNew = await sessionFor(`email:${NEW}`);
	const onOld = await sessionFor(`email:${OLD}`);
	const revert = await issueMagicToken(
		{ purpose: 'email-revert', email: OLD, grant: 'g1', callbackUrl: '/' },
		REVERT_TTL
	);
	moveResult = { ok: true, from: [NEW], memberIds: ['m1', 'm2'] };
	const form = new FormData();
	form.set('token', revert);
	const deleted: string[] = [];
	const out = await route.actions.revert({
		request: new Request('https://x/auth/email?/revert', { method: 'POST', body: form }),
		cookies: { delete: (n: string) => deleted.push(n) }
	} as never);
	assert.deepEqual(out, { reverted: true });
	assert.deepEqual(moves[0], { grant: 'g1' });
	assert.equal(await getSession(onNew), null);
	assert.equal(await getSession(onOld), null);
	assert.equal(deleted.length, 1);
	assert.deepEqual(await revertEmailChange(revert), { ok: false, reason: 'token' });
});

// ---- 6

test('F9 R6: features.md describes the flow and operations.md the lost-both recovery', async () => {
	const { readFileSync, existsSync } = await import('node:fs');
	const features = readFileSync('docs/features.md', 'utf8');
	const section = features.split('## Sign-in email change')[1]?.split('\n## ')[0] ?? '';
	for (const fact of [
		'10 minutes',
		"purpose: 'email-change'",
		'30 minutes',
		"purpose: 'email-revert'",
		'7 days',
		'`group_admin`',
		'`member_star.starrer`',
		'passkey'
	]) {
		assert.ok(section.includes(fact), `features.md's section does not say ${fact}`);
	}
	const ops = readFileSync('docs/operations.md', 'utf8');
	const recovery = ops.split('## Member lost both sign-in addresses')[1]?.split('\n## ')[0] ?? '';
	assert.match(recovery, /deploy\/run\.sh change-member-email /);
	assert.match(recovery, /magic link/);
	assert.ok(existsSync('scripts/change-member-email.ts'), 'the documented script does not exist');
});

test('review R1: a free address answers as fast as a taken one, so timing cannot probe membership', async () => {
	const realSet = redis.set;
	redis.set = async (k: string, v: unknown, o?: { ex?: number }) => {
		if (k.includes(':magic:')) await new Promise((r) => setTimeout(r, 300));
		return realSet(k, v, o);
	};
	try {
		taken.add('taken@example.org');
		const time = async (next: string) => {
			const t = performance.now();
			await ask({ next });
			return performance.now() - t;
		};
		const forTaken = await time('taken@example.org');
		const forFree = await time('free@example.org');
		assert.ok(
			forFree - forTaken < 100,
			`a free address took ${Math.round(forFree)}ms against ${Math.round(forTaken)}ms for a taken one`
		);
	} finally {
		redis.set = realSet;
	}
});
