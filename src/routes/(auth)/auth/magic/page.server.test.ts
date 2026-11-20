import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { isRedirect } from '@sveltejs/kit';

// The property D9 turns on: opening the emailed link leaves the token spendable.
// A Defender Safe Links prefetch is an ordinary GET, so anything the GET spends
// is spent before the member ever sees the mail — and with no password fallback
// the next link burns the same way. Sign-in therefore has to cost a POST.
//
// The store below is this file's own Map standing in for Redis, because
// magic-link.ts reaches `$app/environment` and cannot be loaded under the test
// runner. Peek reads it, confirm deletes it, which is the `get`/`getdel` split
// the real module makes in one line each; the route is what is under test here.

type Payload = { email: string; callbackUrl: string };

const store = new Map<string, Payload>();
let sent: { email: string }[] = [];

mock.module('$lib/server/magic-link', {
	namedExports: {
		peekMagicToken: async (t: string | null) => (t ? (store.get(t) ?? null) : null),
		consumeMagicToken: async (t: string | null) => {
			if (!t) return null;
			const found = store.get(t) ?? null;
			store.delete(t);
			return found;
		},
		mintEmailSession: async (email: string) => `session-for:${email}`,
		sendMagicLink: async (args: { email: string }) => {
			if (!args.email.includes('@')) return { ok: false, reason: 'invalid' };
			sent.push({ email: args.email });
			return { ok: true };
		}
	}
});

mock.module('$lib/server/session-store', {
	namedExports: {
		SESSION_COOKIE_NAME: 'community_session',
		SESSION_COOKIE_OPTIONS: { path: '/', httpOnly: true, sameSite: 'lax' },
		SESSION_TTL: 86400
	}
});

mock.module('$lib/server/gravatar', { namedExports: { refreshOnSignIn: () => {} } });

let logged: { msg: string; ctx?: Record<string, unknown> }[] = [];
const record = (msg: string, ctx?: Record<string, unknown>) => void logged.push({ msg, ctx });
mock.module('$lib/server/log', {
	namedExports: { log: { debug: record, info: record, warn: record, error: record } }
});

const { load, actions } = await import('./+page.server');

const TOKEN = 'tok_c0ffee';
const EMAIL = 'nomi@example.org';
const BASE = 'https://www.example.org/auth/magic';

function seed(): void {
	store.clear();
	sent = [];
	logged = [];
	store.set(TOKEN, { email: EMAIL, callbackUrl: '/members' });
}

// `load` is typed as returning the page's whole data shape, so the narrow union
// this route actually returns needs saying here.
async function open(token: string | null = TOKEN) {
	const url = new URL(token === null ? BASE : `${BASE}?token=${token}`);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (await load({ url } as any)) as { valid: boolean; token?: string; email?: string };
}

async function submit(name: 'confirm' | 'resend', body: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(body)) fd.set(k, v);
	const cookies: { name: string; value: string }[] = [];
	try {
		const data = await actions[name]({
			request: new Request(BASE, { method: 'POST', body: fd }),
			cookies: { set: (name: string, value: string) => cookies.push({ name, value }) },
			url: new URL(BASE),
			getClientAddress: () => '203.0.113.7',
			request_headers: undefined
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} as any);
		return { data, cookies, redirect: null as { status: number; location: string } | null };
	} catch (e) {
		if (!isRedirect(e)) throw e;
		return { data: null, cookies, redirect: { status: e.status, location: e.location } };
	}
}

test('opening the link does not spend the token', async () => {
	seed();

	const first = await open();
	assert.equal(first.valid, true, 'a live token rendered as expired');

	// The scanner went first; the member clicks second and gets the same page.
	const second = await open();
	assert.equal(second.valid, true, 'the GET burned the token — a prefetch locks the member out');
	assert.equal(store.has(TOKEN), true, 'the token left the store on a GET');

	const signIn = await submit('confirm', { token: TOKEN });
	assert.equal(signIn.redirect?.location, '/members', 'the member could not sign in afterwards');
});

test('confirming spends the token, mints the session, and lands on the callback', async () => {
	seed();
	store.set(TOKEN, { email: EMAIL, callbackUrl: '/group/moz/members' });

	const res = await submit('confirm', { token: TOKEN });

	assert.equal(res.redirect?.status, 303);
	assert.equal(res.redirect?.location, '/group/moz/members');
	assert.deepEqual(res.cookies, [{ name: 'community_session', value: `session-for:${EMAIL}` }]);
	assert.equal(store.has(TOKEN), false, 'the token survived confirmation and is replayable');
});

test('a spent token renders the recovery form rather than a dead end', async () => {
	seed();
	await submit('confirm', { token: TOKEN });

	const replay = await submit('confirm', { token: TOKEN });
	assert.equal(replay.redirect, null, 'a spent token still signed someone in');
	assert.equal(replay.cookies.length, 0, 'a spent token still set a session cookie');

	const after = await open();
	assert.equal(after.valid, false, 'the reloaded page claimed the spent token was live');
	assert.equal('token' in after, false, 'the dead page still carries a token to submit');
});

test('the recovery form sends a fresh link and answers generically', async () => {
	seed();

	const ok = await submit('resend', { email: EMAIL });
	assert.equal((ok.data as { sent: boolean }).sent, true);
	assert.deepEqual(sent, [{ email: EMAIL }]);

	const bad = await submit('resend', { email: 'not-an-address' });
	assert.equal((bad.data as { status: number }).status, 400);
	assert.equal(sent.length, 1, 'a malformed address still reached the mailer');
});

// Without this the log answers "someone signed in" and nothing else, so a report
// that members land on /members instead of the page they started on cannot be
// checked against anything but the source.
test('the verified line names where the member landed', async () => {
	seed();
	store.set(TOKEN, { email: EMAIL, callbackUrl: '/group/moz/members' });

	await submit('confirm', { token: TOKEN });

	const line = logged.find((l) => l.msg === 'auth.magic.verified');
	assert.ok(line, 'signing in emitted no auth.magic.verified line');
	assert.equal(line.ctx?.dest, '/group/moz/members');
});

test('the verified line drops a token smuggled through the callback', async () => {
	seed();
	const smuggled = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A';
	store.set(TOKEN, { email: EMAIL, callbackUrl: `/members?token=${smuggled}` });

	await submit('confirm', { token: TOKEN });

	const line = logged.find((l) => l.msg === 'auth.magic.verified');
	assert.equal(line?.ctx?.dest, '/members');
	assert.ok(!JSON.stringify(logged).includes(smuggled), 'a token reached the log stream');
});
