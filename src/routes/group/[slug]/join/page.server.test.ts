import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { isRedirect } from '@sveltejs/kit';

// D8: "Register" and "Login" used to be the same URL. These pin the two halves
// of the split server-side: the join flow's link lands on the request form, and
// /login, which sits outside the group tree, links back into the group the
// visitor came from. magic-link.ts reaches `$app/environment`, which the test
// runner cannot load, so the send is recorded here instead.

let sent: { email: string; callbackUrl?: string | null }[] = [];

mock.module('$lib/server/magic-link', {
	namedExports: {
		sendMagicLink: async (args: { email: string; callbackUrl?: string | null }) => {
			if (!args.email.includes('@')) return { ok: false, reason: 'invalid' };
			sent.push(args);
			return { ok: true };
		}
	}
});
mock.module('$lib/server/client-address', { namedExports: { clientAddress: () => '192.0.2.1' } });

const join = await import('./+page.server');
const login = await import('../../../(auth)/login/+page.server');

type Parent = { member: unknown; isGroupAdmin: boolean; user: unknown };
const GUEST: Parent = { member: null, isGroupAdmin: false, user: null };

async function joinLoad(path: string, parent: Parent) {
	const url = new URL(`https://www.example.org${path}`);
	const event = { url, params: { slug: 'example' }, parent: async () => parent };
	return (join.load as unknown as (e: typeof event) => Promise<unknown>)(event);
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (isRedirect(e)) return e.location;
		throw e;
	}
	assert.fail('expected a redirect');
}

function joinSend(path: string, email: string) {
	const body = new FormData();
	body.set('email', email);
	const url = new URL(`https://www.example.org${path}`);
	const request = new Request(url, { method: 'POST', body });
	const event = { request, url, params: { slug: 'example' } };
	return (join.actions.send as unknown as (e: typeof event) => Promise<unknown>)(event);
}

test('the join link opens the request form, not the directory', async () => {
	sent = [];
	assert.deepEqual(await joinSend('/join', 'new@example.org'), {
		sent: true,
		error: null,
		email: 'new@example.org'
	});
	assert.deepEqual(
		sent.map((s) => s.callbackUrl),
		['/request']
	);

	sent = [];
	await joinSend('/group/example/join', 'new@example.org');
	assert.deepEqual(
		sent.map((s) => s.callbackUrl),
		['/group/example/request'],
		'a prefixed URL lost its group'
	);
});

test('a malformed address is refused without a send', async () => {
	sent = [];
	const r = (await joinSend('/join', 'not-an-address')) as { status: number };
	assert.equal(r.status, 400);
	assert.equal(sent.length, 0);
});

test('the join page renders for a guest and skips ahead for anyone signed in', async () => {
	assert.deepEqual(await joinLoad('/join', GUEST), {});
	assert.equal(
		await redirectOf(joinLoad('/join', { ...GUEST, user: { email: 'a@example.org' } })),
		'/request'
	);
	assert.equal(
		await redirectOf(joinLoad('/join', { ...GUEST, user: {}, member: { id: 'm' } })),
		'/members'
	);
	assert.equal(
		await redirectOf(joinLoad('/group/example/join', { ...GUEST, user: {}, isGroupAdmin: true })),
		'/group/example/members'
	);
});

async function loginLoad(query: string) {
	const url = new URL(`https://www.example.org/login${query}`);
	const event = { url, locals: {} };
	return (login.load as unknown as (e: typeof event) => Promise<Record<string, string>>)(event);
}

test('/login links home and to the join page of the group it was opened for', async () => {
	const clean = await loginLoad('?callbackUrl=%2Fmembers');
	assert.equal(clean.home, '/');
	assert.equal(clean.joinHref, '/join');

	const bare = await loginLoad('');
	assert.equal(bare.home, '/');
	assert.equal(bare.joinHref, '/join');

	const grouped = await loginLoad('?callbackUrl=%2Fgroup%2Fother%2Fmembers%2Fabc');
	assert.equal(grouped.home, '/group/other');
	assert.equal(grouped.joinHref, '/group/other/join');

	// safeLocalPath has already refused an off-origin destination, so a hostile
	// callbackUrl cannot become the home link either.
	const hostile = await loginLoad('?callbackUrl=%2F%2Fevil.example%2Fgroup%2Fx');
	assert.equal(hostile.home, '/');
});
