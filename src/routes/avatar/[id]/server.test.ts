import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, mock } from 'node:test';

// The property: an unauthenticated request for a known member's address is
// indistinguishable from one for an address that belongs to nobody. The old
// endpoint keyed on md5(email), so those two requests answered 200 + image bytes
// and 302 + a Location header — a membership oracle anyone could run against a
// candidate list.
//
// What this rules out, on the wire: the status code, the body, and the complete
// header set. Every refusal comes from one constructor, so a header added to one
// path cannot appear on the other. The distinguisher is stronger than an
// assertion about bytes, though: an address-shaped request reaches neither Redis
// nor Postgres, asserted below through the call counts, so the two requests
// execute the same instructions and there is no work to time. What it does NOT
// rule out is a timing signal on the *id* path — a stored photo takes a query and
// a body write, a miss does not. That costs an attacker nothing to measure and
// buys nothing to know: an id is a random uuid, so a candidate address does not
// produce one to test.

const STORED_ID = '3f6b1a2c-9d84-4c1e-8f37-6b2ad5c90e11';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

// `source: 'upload'` is not incidental. It makes isStale() false, so serving
// this row schedules no Gravatar fetch — a stub that looked like a stale cache
// row would have these tests reaching the network.
const getAvatarByPublicId = mock.fn(async (id: string) =>
	id === STORED_ID
		? {
				bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
				contentType: 'image/png',
				updatedAt: new Date('2026-08-10T00:00:00Z'),
				source: 'upload' as const,
				email: 'stored@example.com',
				fetchedAt: null,
				lastModified: null
			}
		: null
);
const recordGravatar = mock.fn(async () => {});
// Node's module mocking replaces the whole module, so every export the
// subject imports has to appear here or the import throws at load.
const getAvatarByEmail = mock.fn(async () => null);
mock.module('$lib/server/avatars', {
	namedExports: { getAvatarByPublicId, recordGravatar, getAvatarByEmail }
});

// In-memory counters, so the cap under test is the endpoint's own.
const counters = new Map<string, number>();
const incr = mock.fn(async (key: string) => {
	const n = (counters.get(key) ?? 0) + 1;
	counters.set(key, n);
	return n;
});
mock.module('$lib/server/redis', { namedExports: { redis: { incr, expire: async () => 1 } } });

const { GET } = await import('./+server');

// The member is the one with a photo in the mock above; the stranger is not in
// the directory at all. Under the old scheme these hashes were the URLs.
const MEMBER_EMAIL = 'alum@example.com';
const STRANGER_EMAIL = 'nobody@example.com';

function md5(value: string): string {
	return createHash('md5').update(value.trim().toLowerCase()).digest('hex');
}

function get(id: string, opts: { ip?: string; ifNoneMatch?: string } = {}) {
	const url = new URL(`https://www.example.org/avatar/${id}`);
	return {
		url,
		params: { id },
		locals: { sessionId: null, session: null, user: null, marketing: { cohort: '', utm: {} } },
		getClientAddress: () => opts.ip ?? '203.0.113.7',
		request: new Request(url, {
			headers: opts.ifNoneMatch ? { 'if-none-match': opts.ifNoneMatch } : {}
		})
	} as unknown as Parameters<typeof GET>[0];
}

// Everything a caller can see, in a comparable shape.
async function wire(response: Response) {
	return {
		status: response.status,
		headers: [...response.headers].sort(),
		body: await response.text()
	};
}

function reset(): void {
	counters.clear();
	getAvatarByPublicId.mock.resetCalls();
	incr.mock.resetCalls();
}

test('a member address and a stranger address answer identically', async () => {
	reset();
	const member = await wire(await GET(get(md5(MEMBER_EMAIL))));
	const stranger = await wire(await GET(get(md5(STRANGER_EMAIL))));

	assert.deepEqual(member, stranger);
	assert.equal(member.status, 404);
	// Neither request read anything: no query to time, no counter to observe.
	assert.equal(getAvatarByPublicId.mock.callCount(), 0);
	assert.equal(incr.mock.callCount(), 0);
});

test('an unknown photo id answers exactly like an address-shaped one', async () => {
	reset();
	const byId = await wire(await GET(get(UNKNOWN_ID)));
	const byHash = await wire(await GET(get(md5(MEMBER_EMAIL))));

	assert.deepEqual(byId, byHash);
	// The id path did reach the table — the responses match anyway.
	assert.equal(getAvatarByPublicId.mock.callCount(), 1);
});

test('a stored photo still serves its bytes', async () => {
	reset();
	const response = await GET(get(STORED_ID));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'image/png');
	assert.equal((await response.arrayBuffer()).byteLength, 4);
	assert.equal(getAvatarByPublicId.mock.callCount(), 1);
});

test('an unchanged photo revalidates to 304', async () => {
	reset();
	const etag = (await GET(get(STORED_ID))).headers.get('etag');
	assert.ok(etag);
	const response = await GET(get(STORED_ID, { ifNoneMatch: etag }));
	assert.equal(response.status, 304);
});

test('the ids a member did not upload are not enumerable at line speed', async () => {
	reset();
	const ip = '198.51.100.9';
	let last = new Response();
	for (let i = 0; i < 1201; i++) last = await GET(get(UNKNOWN_ID, { ip }));
	assert.equal(last.status, 429);

	// Per IP, not global: a second caller is unaffected by the first one's flood.
	const other = await GET(get(UNKNOWN_ID, { ip: '198.51.100.10' }));
	assert.equal(other.status, 404);
});

test('address-shaped requests are never metered', async () => {
	reset();
	const ip = '198.51.100.11';
	for (let i = 0; i < 2000; i++) await GET(get(md5(STRANGER_EMAIL), { ip }));
	// A flood of garbage must not spend the bucket a real browser needs — a page
	// full of avatars behind the same NAT would go with it.
	assert.equal(incr.mock.callCount(), 0);
	assert.equal((await GET(get(STORED_ID, { ip }))).status, 200);
});

test('a Redis outage serves the photo rather than blanking it', async () => {
	reset();
	incr.mock.mockImplementationOnce(async () => {
		throw new Error('redis down');
	});
	assert.equal((await GET(get(STORED_ID))).status, 200);
});
