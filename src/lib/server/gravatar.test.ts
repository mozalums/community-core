import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHash } from 'node:crypto';

// recordGravatar is the only thing gravatar.ts pulls from the storage layer, and
// importing the real one would want a database. Mocked before the import below.
const recorded: { email: string; result: unknown }[] = [];
type Row = {
	source: 'upload' | 'gravatar' | 'none';
	email: string;
	fetchedAt: Date | null;
	lastModified: string | null;
};
let storedRow: Row | null = null;
mock.module('$lib/server/avatars', {
	namedExports: {
		recordGravatar: async (email: string, result: unknown) => {
			recorded.push({ email, result });
		},
		getAvatarByEmail: async (email: string) =>
			storedRow && storedRow.email === email ? storedRow : null
	}
});

const { gravatarHash, fetchGravatar, isStale, refreshOnSignIn, scheduleRefresh, TTL_MS } =
	await import('./gravatar');

/** Let the detached refresh promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

type FetchArgs = { url: string; headers: Record<string, string> };
const calls: FetchArgs[] = [];

/** Stand in for one Gravatar response. Records what was asked for. */
function stubFetch(reply: { status: number; headers?: Record<string, string>; body?: Uint8Array }) {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calls.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>
		});
		const empty = reply.status === 304 || reply.status === 404;
		const body = empty || !reply.body ? null : new Uint8Array(reply.body).buffer;
		return new Response(body, { status: reply.status, headers: reply.headers ?? {} });
	}) as typeof fetch;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const ADDR = 'Member@Example.COM ';

// Gravatar's spec is explicit that md5 is the wrong digest, and the weak one is
// also what makes confirming a guessed address cheap. A regression to md5 would
// still render photos, so nothing else in the suite would notice.
test('the hash is sha256 of the trimmed, lowercased address', () => {
	const expected = createHash('sha256').update('member@example.com').digest('hex');
	assert.equal(gravatarHash(ADDR), expected);
	assert.equal(gravatarHash(ADDR).length, 64);
});

test('a missing address hashes the empty string rather than throwing', () => {
	assert.equal(gravatarHash(null), createHash('sha256').update('').digest('hex'));
});

test('an upload is never stale, whatever its age', () => {
	assert.equal(isStale({ source: 'upload', fetchedAt: null }), false);
	assert.equal(isStale({ source: 'upload', fetchedAt: new Date(0) }), false);
});

test('a row never asked about is stale', () => {
	assert.equal(isStale({ source: 'none', fetchedAt: null }), true);
	assert.equal(isStale({ source: 'gravatar', fetchedAt: null }), true);
});

test('freshness turns over exactly at the TTL', () => {
	const now = Date.UTC(2026, 7, 18);
	const justInside = new Date(now - TTL_MS + 1000);
	const justOutside = new Date(now - TTL_MS);
	assert.equal(isStale({ source: 'gravatar', fetchedAt: justInside }, now), false);
	assert.equal(isStale({ source: 'gravatar', fetchedAt: justOutside }, now), true);
});

// d=404 is what separates "this member has no photo" from "here is a generated
// robot". Without it every address returns 200 and the cache fills with images
// nobody chose.
test('the request asks for 404 rather than a generated fallback', async () => {
	calls.length = 0;
	stubFetch({ status: 404 });
	await fetchGravatar(gravatarHash(ADDR));
	assert.match(calls[0].url, /[?&]d=404\b/);
	assert.match(calls[0].url, /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?/);
});

test('a 404 is a cacheable absence, not an error', async () => {
	stubFetch({ status: 404 });
	assert.deepEqual(await fetchGravatar(gravatarHash(ADDR)), { outcome: 'none' });
});

// The stored Last-Modified is the only conditional Gravatar honours; they send
// no ETag. Losing this turns each weekly refresh into a full re-download of
// every member's photo, which is the clause about excessive calls.
test('a stored Last-Modified goes back out as If-Modified-Since', async () => {
	calls.length = 0;
	stubFetch({ status: 304 });
	const res = await fetchGravatar(gravatarHash(ADDR), 'Fri, 08 May 2026 14:58:31 GMT');
	assert.deepEqual(res, { outcome: 'unchanged' });
	assert.equal(calls[0].headers['if-modified-since'], 'Fri, 08 May 2026 14:58:31 GMT');
});

test('no stored date means no conditional header', async () => {
	calls.length = 0;
	stubFetch({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG });
	await fetchGravatar(gravatarHash(ADDR), null);
	assert.equal(calls[0].headers['if-modified-since'], undefined);
});

test('an image comes back with its bytes and its Last-Modified', async () => {
	stubFetch({
		status: 200,
		headers: { 'content-type': 'image/png', 'last-modified': 'Fri, 08 May 2026 14:58:31 GMT' },
		body: PNG
	});
	const res = await fetchGravatar(gravatarHash(ADDR));
	assert.equal(res.outcome, 'image');
	if (res.outcome !== 'image') return;
	assert.deepEqual(new Uint8Array(res.bytes), PNG);
	assert.equal(res.contentType, 'image/png');
	assert.equal(res.lastModified, 'Fri, 08 May 2026 14:58:31 GMT');
});

// These bytes get re-served from our own origin under our own domain, so a
// content-type accepted here is one we would hand a visitor ourselves.
test('a non-image content-type is refused rather than stored', async () => {
	stubFetch({
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' },
		body: new TextEncoder().encode('<script>')
	});
	const res = await fetchGravatar(gravatarHash(ADDR));
	assert.equal(res.outcome, 'error');
});

test('an empty 200 is an error, not a zero-byte photo', async () => {
	stubFetch({ status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array() });
	assert.equal((await fetchGravatar(gravatarHash(ADDR))).outcome, 'error');
});

// A 5xx or a timeout must not be recorded as "this member has no photo": that
// would cache a blip for a week. It returns error, and the caller leaves the row
// stale so the next request retries.
test('a server error is reported, not mistaken for an absence', async () => {
	stubFetch({ status: 503 });
	const res = await fetchGravatar(gravatarHash(ADDR));
	assert.equal(res.outcome, 'error');
	if (res.outcome === 'error') assert.match(res.reason, /503/);
});

test('a network failure is caught and reported', async () => {
	globalThis.fetch = (async () => {
		throw new Error('getaddrinfo ENOTFOUND');
	}) as typeof fetch;
	const res = await fetchGravatar(gravatarHash(ADDR));
	assert.equal(res.outcome, 'error');
	if (res.outcome === 'error') assert.match(res.reason, /ENOTFOUND/);
});

// --- refresh on sign-in ----------------------------------------------------
//
// Signing in is the strongest "active user" signal this app has, and the moment
// somebody who just changed their picture goes looking for it. What must not
// happen is a sign-in that waits on Gravatar, or a lookup performed for a
// stranger who merely holds an inbox.

test('signing in refreshes a stale row for that address', async () => {
	calls.length = 0;
	recorded.length = 0;
	storedRow = {
		source: 'gravatar',
		email: 'member@example.com',
		fetchedAt: new Date(Date.now() - TTL_MS - 1000),
		lastModified: 'Fri, 08 May 2026 14:58:31 GMT'
	};
	stubFetch({ status: 304 });
	refreshOnSignIn('  Member@Example.COM  ');
	await settle();
	assert.equal(calls.length, 1, 'the stale row was not refreshed');
	assert.equal(calls[0].headers['if-modified-since'], 'Fri, 08 May 2026 14:58:31 GMT');
	assert.equal(
		recorded[0]?.result && (recorded[0].result as { outcome: string }).outcome,
		'unchanged'
	);
});

test('a fresh row is left alone', async () => {
	calls.length = 0;
	storedRow = {
		source: 'gravatar',
		email: 'member@example.com',
		fetchedAt: new Date(),
		lastModified: null
	};
	stubFetch({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG });
	refreshOnSignIn('member@example.com');
	await settle();
	assert.equal(calls.length, 0);
});

// The member uploaded a photo. Nothing at Gravatar gets to replace it, and there
// is no reason to ask.
test("an uploader's sign-in asks Gravatar nothing", async () => {
	calls.length = 0;
	storedRow = {
		source: 'upload',
		email: 'member@example.com',
		fetchedAt: null,
		lastModified: null
	};
	stubFetch({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG });
	refreshOnSignIn('member@example.com');
	await settle();
	assert.equal(calls.length, 0);
});

// Anyone with an inbox can complete a magic link. Someone this app displays
// nowhere must not cause a lookup on their address.
test('a signed-in stranger with no row causes no request', async () => {
	calls.length = 0;
	storedRow = null;
	stubFetch({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG });
	refreshOnSignIn('stranger@example.com');
	await settle();
	assert.equal(calls.length, 0);
});

test('a missing address is a no-op rather than a hash of the empty string', async () => {
	calls.length = 0;
	storedRow = null;
	stubFetch({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG });
	refreshOnSignIn(null);
	refreshOnSignIn('   ');
	await settle();
	assert.equal(calls.length, 0);
});

// The privacy notice says a failed lookup keeps nothing and the next display
// asks again, so a weekly ceiling is not a claim it can make; the notice's
// wording is held to this behavior in src/lib/skin/skin.test.ts (E32 R4).
test('E32 R4: a failed lookup records nothing, so the next display asks Gravatar again', async () => {
	const realFetch = globalThis.fetch;
	try {
		recorded.length = 0;
		calls.length = 0;
		stubFetch({ status: 503 });
		const row = { email: 'retry@example.org', source: 'none' as const, fetchedAt: null, lastModified: null };
		scheduleRefresh(row);
		await settle();
		scheduleRefresh(row);
		await settle();
		assert.equal(calls.length, 2);
		assert.equal(recorded.length, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});
