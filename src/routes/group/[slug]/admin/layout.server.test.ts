import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// D12's property: refusing a non-admin costs them nothing. The refusal is
// followed the way a browser follows it — a thrown redirect is dispatched to the
// handler its Location names — so what is asserted is the session that survives,
// not the shape of the refusal. Against the pre-fix tree the gate redirected to
// /logout, this followed it, and the session was gone.
//
// The Map below stands in for Redis.

const SESSION_ID = 's-member';
const sessions = new Map<string, { email: string }>();
let cookieCleared = false;

mock.module('$lib/server/session-store', {
	namedExports: {
		SESSION_COOKIE_NAME: 'community_session',
		SESSION_COOKIE_OPTIONS: { path: '/', httpOnly: true, sameSite: 'lax' },
		deleteSession: async (id: string) => {
			sessions.delete(id);
		}
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { load } = await import('./+layout.server');
const logout = (await import('../../../(auth)/logout/+server')) as unknown as {
	GET?: (event: unknown) => Promise<Response>;
	POST: (event: unknown) => Promise<Response>;
};

// `url` is stubbed even though the gate no longer reads it: it did pre-fix, to
// build the ?next= it handed to /logout, and a stub that omits it would fail
// there with a TypeError instead of the redirect this file exists to follow.
const gate = load as unknown as (event: {
	parent: () => Promise<{ isGroupAdmin: boolean }>;
	url: URL;
}) => Promise<unknown>;

const ADMIN_URL = new URL('https://www.example.org/admin/requests');

function cookieJar() {
	return {
		get: () => SESSION_ID,
		delete: () => {
			cookieCleared = true;
		}
	};
}

// A thrown redirect is duck-typed rather than matched with `isRedirect`: the
// test runner's module mocks give this file its own copy of @sveltejs/kit, so
// the route's Redirect fails an instanceof check against ours.
async function follow(thrown: unknown): Promise<void> {
	const location = (thrown as { status?: number; location?: string }).location;
	if (!location) return;
	const url = new URL(location, 'https://www.example.org');
	if (url.pathname !== '/logout') return;
	// No GET handler means a browser following this gets a 405, not a sign-out.
	if (typeof logout.GET !== 'function') return;
	await logout.GET({ cookies: cookieJar(), url }).catch(() => {});
}

test('refusing a non-admin an admin route leaves their session intact', async () => {
	sessions.clear();
	sessions.set(SESSION_ID, { email: 'member@example.com' });
	cookieCleared = false;

	const refusal = await gate({
		parent: async () => ({ isGroupAdmin: false }),
		url: ADMIN_URL
	}).then(
		() => null,
		(e: unknown) => e
	);
	assert.ok(refusal, 'the gate let a non-admin into the admin subtree');

	await follow(refusal);

	assert.ok(sessions.has(SESSION_ID), 'the refusal destroyed the session it refused');
	assert.equal(cookieCleared, false, 'the refusal cleared the session cookie');
});

// Without this the file would still pass if the gate refused everyone, and a
// gate that refuses admins is not a gate, it is an outage.
test('a group admin is let through', async () => {
	await gate({ parent: async () => ({ isGroupAdmin: true }), url: ADMIN_URL });
});

// A8: a GET sign-out is reachable by any page that can put a top-level
// navigation in front of the browser.
test('/logout answers POST only', () => {
	assert.equal(typeof logout.POST, 'function');
	assert.equal(logout.GET, undefined);
});
