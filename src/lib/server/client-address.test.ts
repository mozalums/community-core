import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveClientAddress } from './client-address';

// The three shapes the rate-limit key has to survive: no proxy, one nginx hop,
// and a client that sends its own X-Forwarded-For to steer the key.
const PEER = '127.0.0.1'; // nginx, on loopback, as the container sees it
const CLIENT = '203.0.113.7';
const SPOOFED = '198.51.100.9';

const headers = (init?: Record<string, string>) => new Headers(init);

test('no ADDRESS_HEADER: the TCP peer is the client', () => {
	const ip = resolveClientAddress({
		headers: headers(),
		peer: CLIENT,
		env: { addressHeader: undefined, xffDepth: undefined }
	});
	assert.equal(ip, CLIENT);
});

test('one nginx hop: the address nginx wrote is the client', () => {
	const ip = resolveClientAddress({
		headers: headers({ 'x-forwarded-for': CLIENT }),
		peer: PEER,
		env: { addressHeader: 'X-Forwarded-For', xffDepth: '1' }
	});
	assert.equal(ip, CLIENT);
});

test('a client-supplied X-Forwarded-For is not honoured at the real hop count', () => {
	// $proxy_add_x_forwarded_for appends nginx's peer to whatever the client
	// sent, so the spoof lands left of the entry nginx wrote and depth 1 reads
	// past it.
	const ip = resolveClientAddress({
		headers: headers({ 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` }),
		peer: PEER,
		env: { addressHeader: 'X-Forwarded-For', xffDepth: '1' }
	});
	assert.equal(ip, CLIENT);
	assert.notEqual(ip, SPOOFED);
});

test('ADDRESS_HEADER without XFF_DEPTH falls back to the peer', () => {
	// The naive fix: with no trusted hop count the header is client-writable, so
	// the resolver refuses it and keys on the peer instead — today's collapsed
	// bucket, not an attacker-chosen one.
	const ip = resolveClientAddress({
		headers: headers({ 'x-forwarded-for': SPOOFED }),
		peer: PEER,
		env: { addressHeader: 'X-Forwarded-For', xffDepth: undefined }
	});
	assert.equal(ip, PEER);
});

test('a header the proxy never sent falls back to the peer, not an empty key', () => {
	const ip = resolveClientAddress({
		headers: headers(),
		peer: PEER,
		env: { addressHeader: 'X-Forwarded-For', xffDepth: '1' }
	});
	assert.equal(ip, PEER);
});

test('the env vars are inert unless nginx overwrites what the client sent', () => {
	// One hop's worth of header, all of it client-authored: nginx did not set
	// X-Forwarded-For, so depth 1 reads the client's own value. This is the
	// failure requirement 2's server block exists to prevent, pinned as a test
	// so removing the proxy_set_header line changes an assertion.
	const ip = resolveClientAddress({
		headers: headers({ 'x-forwarded-for': SPOOFED }),
		peer: PEER,
		env: { addressHeader: 'X-Forwarded-For', xffDepth: '1' }
	});
	assert.equal(ip, SPOOFED);
});
