import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SESSION_TTL, sessionExpiresAt, sessionExpired } from './session-lifetime';

// A fixed instant, so every assertion below is arithmetic rather than a race
// with the clock.
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

test('SESSION_TTL is 24 hours, in seconds', () => {
	assert.equal(SESSION_TTL, 86400);
});

test('a session minted now dies 24 hours from now', () => {
	assert.equal(sessionExpiresAt(NOW), NOW + DAY);
});

test('the deadline is absolute — a later mint does not extend an earlier one', () => {
	const first = sessionExpiresAt(NOW);
	sessionExpiresAt(NOW + 12 * 60 * 60 * 1000);
	assert.equal(first, NOW + DAY);
});

test('alive one millisecond short of the deadline, expired on it', () => {
	const session = { expiresAt: sessionExpiresAt(NOW) };
	assert.equal(sessionExpired(session, NOW + DAY - 1), false);
	assert.equal(sessionExpired(session, NOW + DAY), true);
	assert.equal(sessionExpired(session, NOW + DAY + 1), true);
});

// The regression this guards: an unstamped session made the check below dead
// code, leaving a key that lost its TTL authenticating forever.
test('a session stamped 24 hours ago is expired, whatever Redis did with the key', () => {
	assert.equal(sessionExpired({ expiresAt: NOW - DAY }, NOW), true);
});

test('an unstamped session is not expired by this check', () => {
	assert.equal(sessionExpired({ expiresAt: 0 }, NOW), false);
	assert.equal(sessionExpired({}, NOW), false);
});

test('no session is not an expired session', () => {
	assert.equal(sessionExpired(null, NOW), false);
	assert.equal(sessionExpired(undefined, NOW), false);
});
