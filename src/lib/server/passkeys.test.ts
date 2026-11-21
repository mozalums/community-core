import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isHttpError } from '@sveltejs/kit';
import { MIGRATIONS } from './migrations';

// Passkey registration and sign-in through the real routes, the real
// credential store and the real WebAuthn verification. The responses being
// verified are passkeys.fixture.json: what Chrome sent with a CDP virtual
// authenticator during scripts/f08-passkey-e2e.mts. Redis and Postgres are
// this file's own maps, so the challenge and counter checks are observed
// where they are kept.

const fixture = JSON.parse(
	readFileSync(new URL('./passkeys.fixture.json', import.meta.url), 'utf8')
);

process.env.ORIGIN = fixture.origin;
process.env.PUBLIC_BASE_DOMAIN = fixture.rpID;
process.env.LOREM_REDIS_PREFIX = 'f8test';
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

// ---- Redis: the operations the session store, limiter and challenges issue.
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
	del: async (...ks: string[]) => ks.forEach((k) => kv.delete(k)),
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

// ---- Postgres: the passkey_credential statements, against a map by id.
type Row = {
	id: Buffer;
	member_id: string;
	public_key: Buffer;
	sign_count: string;
	transports: string[];
	backed_up: boolean;
	device_type: string;
	nickname: string;
	created_at: Date;
	last_used_at: Date | null;
};
const credentials = new Map<string, Row>();
const members = new Map<string, string>([[fixture.memberId, fixture.email]]);
const hex = (b: Buffer) => b.toString('hex');
async function query(sql: string, p: unknown[] = []) {
	const s = sql.replace(/\s+/g, ' ').trim();
	if (s.startsWith('INSERT INTO passkey_credential')) {
		const id = p[0] as Buffer;
		if (credentials.has(hex(id))) return { rows: [], rowCount: 0 };
		credentials.set(hex(id), {
			id,
			member_id: p[1] as string,
			public_key: p[2] as Buffer,
			sign_count: String(p[3]),
			transports: p[4] as string[],
			backed_up: p[5] as boolean,
			device_type: p[6] as string,
			nickname: p[7] as string,
			created_at: new Date(),
			last_used_at: null
		});
		return { rows: [], rowCount: 1 };
	}
	if (s.startsWith('SELECT c.member_id')) {
		const r = credentials.get(hex(p[0] as Buffer));
		const email = r && members.get(r.member_id);
		return { rows: r && email ? [{ ...r, email }] : [], rowCount: r ? 1 : 0 };
	}
	if (s.startsWith('UPDATE passkey_credential')) {
		const r = credentials.get(hex(p[0] as Buffer));
		if (!r || r.sign_count !== String(p[3])) return { rows: [], rowCount: 0 };
		Object.assign(r, { sign_count: String(p[1]), backed_up: p[2], last_used_at: new Date() });
		return { rows: [], rowCount: 1 };
	}
	if (s.startsWith('SELECT')) {
		const rows = [...credentials.values()].filter((r) => r.member_id === p[0]);
		return { rows, rowCount: rows.length };
	}
	if (s.startsWith('DELETE FROM passkey_credential')) {
		const r = credentials.get(hex(p[0] as Buffer));
		if (!r || r.member_id !== p[1]) return { rows: [], rowCount: 0 };
		credentials.delete(hex(p[0] as Buffer));
		return { rows: [], rowCount: 1 };
	}
	throw new Error(`unexpected SQL: ${s}`);
}
mock.module('$lib/server/postgres', { namedExports: { query } });

const warnings: { msg: string; ctx?: Record<string, unknown> }[] = [];
mock.module('$lib/server/log', {
	namedExports: {
		log: {
			debug() {},
			info() {},
			warn: (msg: string, ctx?: Record<string, unknown>) => warnings.push({ msg, ctx }),
			error() {}
		}
	}
});
mock.module('$lib/server/gravatar', { namedExports: { refreshOnSignIn: () => {} } });

const group = { id: 'g1', slug: 'example' };
const member = { id: fixture.memberId, email: fixture.email, name: 'Pat Key', identSubject: null };
mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => group } });
mock.module('$lib/server/members', {
	namedExports: {
		getMemberById: async (_g: string, id: string) => (id === member.id ? member : null),
		canEditMember: (m: typeof member, u: { email: string } | null, admin: boolean) =>
			admin || u?.email === m.email
	}
});

const source = (p: string) => pathToFileURL(resolve(p)).href;
const signIn = await import(source('src/routes/(auth)/auth/passkey/+server.ts'));
const own = await import(source('src/routes/group/[slug]/members/[id]/passkeys/+server.ts'));
const { sessionIsFresh, FRESH_SESSION_MS } = await import('./passkeys');
const { SESSION_TTL } = await import('./session-lifetime');

const IP = '198.51.100.7';
const PREFIX = 'f8test';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function freshSession(mintedAgoMs = 0) {
	const subject = `email:${member.email}`;
	return {
		user: { id: subject, subject, email: member.email, name: '', image: '' },
		accessToken: '',
		idToken: '',
		expiresAt: Date.now() - mintedAgoMs + SESSION_TTL * 1000,
		profile: {}
	};
}

function event(opts: {
	method?: string;
	body?: unknown;
	sessionId?: string | null;
	session?: unknown;
	path?: string;
	ip?: string;
}) {
	const set: Record<string, string> = {};
	const path = opts.path ?? `/members/${member.id}/passkeys`;
	return {
		set,
		event: {
			params: { slug: 'example', id: member.id },
			url: new URL(`${fixture.origin}${path}`),
			request: new Request(`${fixture.origin}${path}`, {
				method: opts.method ?? 'POST',
				headers: { 'content-type': 'application/json' },
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
			}),
			locals: {
				sessionId: opts.sessionId ?? null,
				session: opts.session ?? null,
				user: (opts.session as { user?: unknown } | undefined)?.user ?? null
			},
			cookies: { set: (name: string, value: string) => (set[name] = value) },
			getClientAddress: () => opts.ip ?? IP,
			platform: undefined
		} as never
	};
}

async function status(p: Promise<Response>): Promise<number> {
	try {
		return (await p).status;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

// Asks the route for options, then puts the fixture's challenge where the route
// stored its own, so the recorded response answers what this session was issued.
async function issueRegistration(sessionId: string) {
	const { event: e } = event({ body: { step: 'options' }, sessionId, session: freshSession() });
	const res = await own.POST(e);
	assert.equal(res.status, 200);
	const options = await res.json();
	const key = `${PREFIX}:passkey:reg:${sha(sessionId)}`;
	assert.deepEqual(kv.get(key), { challenge: options.challenge, memberId: member.id });
	kv.set(key, { challenge: fixture.registrationOptions.challenge, memberId: member.id });
	return { options, key };
}

async function register_(sessionId: string, nickname = 'Laptop') {
	const { event: e } = event({
		body: { step: 'verify', response: fixture.registrationResponse, nickname },
		sessionId,
		session: freshSession()
	});
	return own.POST(e);
}

async function issueSignIn() {
	const { event: e } = event({ body: { step: 'options' }, path: '/auth/passkey' });
	const res = await signIn.POST(e);
	assert.equal(res.status, 200);
	kv.set(`${PREFIX}:passkey:auth:${sha(fixture.authenticationOptions.challenge)}`, 1);
	return res.json();
}

async function signIn_(ip = IP) {
	const { event: e, set } = event({
		body: { step: 'verify', response: fixture.authenticationResponse, callbackUrl: '/members' },
		path: '/auth/passkey',
		ip
	});
	const res = await signIn.POST(e);
	return { res, set, body: await res.json() };
}

function reset() {
	kv.clear();
	ttl.clear();
	sets.clear();
	credentials.clear();
	warnings.length = 0;
}

test('F8 R1: migration 18 keys passkey_credential by member, cascading on member delete', () => {
	const m = MIGRATIONS.find((x) => x.version === 18);
	assert.ok(m, 'no migration 18');
	const sql = m.sql.replace(/\s+/g, ' ');
	for (const col of [
		'id bytea PRIMARY KEY',
		'member_id uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE',
		'public_key bytea',
		'sign_count bigint',
		'transports text[]',
		'backed_up bool',
		'device_type text',
		'nickname text',
		'created_at timestamptz',
		'last_used_at timestamptz'
	]) {
		assert.ok(sql.includes(col), `passkey_credential lacks ${col}`);
	}
	assert.doesNotMatch(sql, /\bemail\b/, 'a passkey row must not carry the address');
});

test('F8 R1: both WebAuthn packages are pinned to exact versions the lockfile records', () => {
	const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
	const lock = readFileSync('pnpm-lock.yaml', 'utf8');
	for (const name of ['@simplewebauthn/server', '@simplewebauthn/browser']) {
		const version = pkg.dependencies[name];
		assert.match(version ?? '', /^\d+\.\d+\.\d+$/, `${name} is not pinned exactly`);
		assert.ok(
			lock.includes(`'${name}':\n        specifier: ${version}\n        version: ${version}`),
			`pnpm-lock.yaml does not record ${name}@${version}`
		);
	}
});

test('F8 R2: a fresh session registers the recorded attestation under the member, with its nickname', async () => {
	reset();
	const { options, key } = await issueRegistration('sid-1');
	assert.equal(ttl.get(key), 300, 'challenge TTL is five minutes');
	assert.equal(options.rp.id, fixture.rpID, 'rpID is the apex');
	assert.equal(options.authenticatorSelection.residentKey, 'required');
	assert.equal(options.authenticatorSelection.userVerification, 'preferred');

	const res = await register_('sid-1', '  Laptop  ');
	assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
	const rows = [...credentials.values()];
	assert.equal(rows.length, 1);
	assert.equal(rows[0].member_id, member.id);
	assert.equal(rows[0].nickname, 'Laptop');
	assert.equal(rows[0].id.toString('base64url'), fixture.registrationResponse.id);
	assert.ok(rows[0].public_key.length > 0);
	assert.equal(kv.has(key), false, 'the challenge outlived its use');
});

test('F8 R2/R5: a replayed registration challenge is refused', async () => {
	reset();
	await issueRegistration('sid-1');
	assert.equal((await register_('sid-1')).status, 200);
	credentials.clear();
	const replay = await register_('sid-1');
	assert.equal(replay.status, 400);
	assert.deepEqual(await replay.json(), { error: 'challenge' });
	assert.equal(credentials.size, 0);
});

test('F8 R2: a challenge issued to one session does not register from another', async () => {
	reset();
	await issueRegistration('sid-1');
	const res = await register_('sid-2');
	assert.equal(res.status, 400);
	assert.deepEqual(await res.json(), { error: 'challenge' });
});

test('F8 R2: registration needs a session minted in the last ten minutes', async () => {
	reset();
	assert.equal(sessionIsFresh(freshSession(FRESH_SESSION_MS - 1000)), true);
	assert.equal(sessionIsFresh(freshSession(FRESH_SESSION_MS + 1000)), false);
	assert.equal(sessionIsFresh({ expiresAt: 0 }), false, 'an unstamped session is not fresh');
	const { event: e } = event({
		body: { step: 'options' },
		sessionId: 'sid-1',
		session: freshSession(FRESH_SESSION_MS + 1000)
	});
	const res = await own.POST(e);
	assert.equal(res.status, 403);
	assert.deepEqual(await res.json(), { error: 'stale' });
	assert.equal(kv.size, 0, 'a stale session was issued a challenge');
});

test('F8 R2: only the member themself may register, not a signed-out visitor or another member', async () => {
	reset();
	const other = freshSession();
	other.user = {
		...other.user,
		email: 'someone@example.org',
		subject: 'email:someone@example.org'
	};
	for (const e of [
		event({ body: { step: 'options' } }).event,
		event({ body: { step: 'options' }, sessionId: 'sid-x', session: other }).event
	]) {
		assert.equal(await status(own.POST(e)), 403);
	}
});

test('F8 R3: the recorded assertion signs in as the member, through the magic-link session mint', async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1');
	await issueSignIn();
	const { res, set, body } = await signIn_();
	assert.equal(res.status, 200, JSON.stringify(body));
	assert.deepEqual(body, { redirect: '/members' });

	const sessionId = set.community_session;
	assert.ok(sessionId, 'no session cookie');
	const session = kv.get(`${PREFIX}:session:${sessionId}`) as { user: { subject: string } };
	assert.equal(session.user.subject, `email:${member.email}`);
	assert.ok(sets.get(`${PREFIX}:usersessions:email:${member.email}`)?.has(sessionId));

	const row = [...credentials.values()][0];
	assert.equal(row.sign_count, '2', 'sign_count follows the assertion');
	assert.ok(row.last_used_at, 'last_used_at stamped');
});

test('F8 R3: the session follows the member row, so a changed address signs in as the new one', async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1');
	members.set(member.id, 'renamed@example.org');
	try {
		await issueSignIn();
		const { set } = await signIn_();
		const session = kv.get(`${PREFIX}:session:${set.community_session}`) as {
			user: { subject: string };
		};
		assert.equal(session.user.subject, 'email:renamed@example.org');
	} finally {
		members.set(member.id, fixture.email);
	}
});

test('F8 R3/R5: a replayed sign-in challenge is refused', async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1');
	await issueSignIn();
	assert.equal((await signIn_()).res.status, 200);
	[...credentials.values()][0].sign_count = '0';
	const replay = await signIn_();
	assert.equal(replay.res.status, 401);
	assert.deepEqual(replay.body, { error: 'challenge' });
	assert.deepEqual(replay.set, {}, 'a replay minted a session');
});

test('F8 R3/R5: a sign-count regression is refused and logged', async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1');
	const row = [...credentials.values()][0];
	row.sign_count = '2';
	await issueSignIn();
	const { res, set, body } = await signIn_();
	assert.equal(res.status, 401);
	assert.deepEqual(body, { error: 'sign_count' });
	assert.deepEqual(set, {}, 'a cloned key minted a session');
	assert.equal(row.sign_count, '2', 'the stored count moved');
	const logged = warnings.find((w) => w.msg === 'auth.passkey.sign-count-regression');
	assert.ok(logged, 'the regression was not logged');
	assert.equal(logged.ctx?.memberId, member.id);
	assert.equal(logged.ctx?.presented, 2);
});

test('F8 R3: an assertion for an unknown credential is refused', async () => {
	reset();
	await issueSignIn();
	const { res, body, set } = await signIn_();
	assert.equal(res.status, 401);
	assert.deepEqual(body, { error: 'unknown' });
	assert.deepEqual(set, {});
});

test('F8 R3: passkey sign-in spends the magic link per-IP counter and stops at its cap', async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1');
	const counter = `${PREFIX}:magic-rl:ip:${IP}`;
	// What twenty magic-link requests from this address leave behind.
	kv.set(counter, 20);
	await issueSignIn();
	const { res, set } = await signIn_();
	assert.equal(res.status, 429);
	assert.deepEqual(set, {});
	assert.equal(kv.get(counter), 21, 'the attempt did not spend the shared counter');

	kv.delete(counter);
	await signIn_('203.0.113.9');
	assert.equal(kv.get(`${PREFIX}:magic-rl:ip:203.0.113.9`), 1);
});

test('F8 R4: the member lists their passkeys with nickname, created and last used, and removes them', async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1', 'Phone');
	const session = freshSession();
	const list = await own.GET(event({ method: 'GET', sessionId: 'sid-1', session }).event);
	const rows = await list.json();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].nickname, 'Phone');
	assert.equal(rows[0].id, fixture.registrationResponse.id);
	assert.ok(Date.parse(rows[0].createdAt));
	assert.equal(rows[0].lastUsedAt, null);

	// The last one goes too: the magic link still signs the member in.
	const removed = await own.DELETE(
		event({ method: 'DELETE', body: { id: rows[0].id }, sessionId: 'sid-1', session }).event
	);
	assert.equal(removed.status, 200);
	assert.equal(credentials.size, 0);
	const again = await own.DELETE(
		event({ method: 'DELETE', body: { id: rows[0].id }, sessionId: 'sid-1', session }).event
	);
	assert.equal(again.status, 404);
});

test("F8 R4: another member cannot list or remove a member's passkeys", async () => {
	reset();
	await issueRegistration('sid-1');
	await register_('sid-1');
	const other = freshSession();
	other.user = {
		...other.user,
		email: 'someone@example.org',
		subject: 'email:someone@example.org'
	};
	const id = fixture.registrationResponse.id;
	assert.equal(
		await status(own.GET(event({ method: 'GET', sessionId: 's', session: other }).event)),
		403
	);
	assert.equal(
		await status(
			own.DELETE(event({ method: 'DELETE', body: { id }, sessionId: 's', session: other }).event)
		),
		403
	);
	assert.equal(credentials.size, 1);
});

mock.module('$lib/server/schema', { namedExports: { ensureSchema: async () => {} } });
mock.module('$lib/server/audit', { namedExports: { startAuditPruner: () => {} } });
const { with_request_store } = await import(
	source('node_modules/@sveltejs/kit/src/exports/internal/server.js')
);
const { handle } = await import(source('src/hooks.server.ts'));

test('F8 R5: with passkeys on a guest is sent to sign in before the passkey handler runs', async () => {
	const state = { tracing: { record_span: ({ fn }: { fn: (s: object) => unknown }) => fn({}) } };
	const at = `/members/${fixture.memberId}/passkeys`;
	for (const path of [at, `/group/example${at}`]) {
		for (const method of ['GET', 'POST', 'DELETE']) {
			const url = new URL(`${fixture.origin}${path}`);
			const e = {
				url,
				request: new Request(url, { method }),
				params: { slug: 'example', id: fixture.memberId },
				route: { id: '/group/[slug]/members/[id]/passkeys' },
				locals: {},
				cookies: { get: () => undefined, set() {}, delete() {} },
				getClientAddress: () => IP
			};
			let reached = false;
			let outcome: { status: number; location: string | null };
			try {
				const res: Response = await with_request_store({ event: e, state } as never, () =>
					handle({
						event: e,
						resolve: () => {
							reached = true;
							return new Response(null, { status: 200 });
						}
					} as never)
				);
				outcome = { status: res.status, location: res.headers.get('location') };
			} catch (thrown) {
				const r = thrown as { status?: number; location?: string };
				if (!r.status) throw thrown;
				outcome = { status: r.status, location: r.location ?? null };
			}
			assert.equal(outcome.status, 303, `${method} ${path}`);
			assert.equal(outcome.location, `/login?callbackUrl=${encodeURIComponent(path)}`);
			assert.equal(reached, false, `${method} ${path} reached the handler as a guest`);
		}
	}
});
