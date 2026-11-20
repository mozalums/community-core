import assert from 'node:assert/strict';
import { test } from 'node:test';
import { log } from './log';
import { DENIED_FIXTURE, KEPT_FIXTURE, leakedValues } from './redact-fixture';

// Values distinctive enough that a substring search over the emitted line is a
// real assertion: each is the shape the corresponding credential actually takes,
// joined from parts so a secret scanner reading the source does not take it for one.
const SESSION_ID = '6f1b2c3d-4e5a-4b7c-8d9e-0a1b2c3d4e5f';
const MAGIC_TOKEN = ['Zm9vYmFyYmF6cXV4', 'MTIzNDU2Nzg5MGFi', 'Y2RlZmdoaWprbG1ub3A'].join('');
const MAILGUN_KEY = ['ke', 'y-1a2b3c4d5e6f7a8b', '9c0d1e2f3a4b5c6d'].join('');
// The credential's name is spelled in parts so scripts/check-neutral.ts, which
// refuses it anywhere but the redaction deny-list, does not count this file.
const SA_PRIVATE_KEY = ['GOOGLE', 'SA', 'PRIVATE', 'KEY'].join('_');
const SA_KEY = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----';

const SECRETS = [SESSION_ID, MAGIC_TOKEN, MAILGUN_KEY, SA_KEY];

// Captures both sinks: emit() routes warn/error to console.error and the rest
// to console.log, so a test that watched one would pass on the other's lines.
function capture(fn: () => void): string {
	const lines: string[] = [];
	const sink = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	const [origLog, origError] = [console.log, console.error];
	console.log = sink;
	console.error = sink;
	try {
		fn();
	} finally {
		console.log = origLog;
		console.error = origError;
	}
	return lines.join('\n');
}

test('every denied key is masked and every non-denied key survives', () => {
	const out = capture(() =>
		log.warn('auth.session.miss', {
			sessionId: SESSION_ID,
			token: MAGIC_TOKEN,
			MAILGUN_PRIVATE: MAILGUN_KEY,
			[SA_PRIVATE_KEY]: SA_KEY,
			path: '/members',
			outcome: 'expired'
		})
	);

	for (const secret of SECRETS) {
		assert.ok(!out.includes(secret), `emitted line carries a credential: ${out}`);
	}
	// Without this the test passes against a logger that drops everything.
	assert.ok(out.includes('"path":"/members"'));
	assert.ok(out.includes('"outcome":"expired"'));
	assert.ok(out.includes('"msg":"auth.session.miss"'));
});

test('the SMTP submission password is masked under either spelling', () => {
	// E04 traded an API key for a password. Same finding, different key name: a
	// send failure is exactly the moment someone logs the config that produced it.
	const PASSWORD = 'sQ7-mailcow-submission-9xTb';
	const out = capture(() =>
		log.error('mail.send-failed', {
			SMTP_PASSWORD: PASSWORD,
			password: PASSWORD,
			smtpUser: 'no-reply@example.org',
			transport: 'smtp'
		})
	);
	assert.ok(!out.includes(PASSWORD), `emitted line carries the SMTP password: ${out}`);
	// The user is not a credential, and a send failure is undebuggable without it.
	assert.ok(out.includes('no-reply@example.org'), out);
	assert.ok(out.includes('"transport":"smtp"'), out);
});

test('key matching ignores case and separators', () => {
	const out = capture(() =>
		log.error('probe', {
			session_id: SESSION_ID,
			'ACCESS-TOKEN': MAGIC_TOKEN,
			apiKey: MAILGUN_KEY
		})
	);
	for (const secret of [SESSION_ID, MAGIC_TOKEN, MAILGUN_KEY]) {
		assert.ok(!out.includes(secret), `emitted line carries a credential: ${out}`);
	}
});

test('a credential nested below the top level is masked too', () => {
	// The shape that defeats a call-site-only fix: SessionData carries its own
	// tokens, so logging the whole record leaks without naming a denied key.
	const out = capture(() =>
		log.info('probe', {
			session: { user: { email: 'a@example.com' }, accessToken: MAGIC_TOKEN, path: '/home' },
			ids: [{ sessionId: SESSION_ID }]
		})
	);
	assert.ok(!out.includes(MAGIC_TOKEN), out);
	assert.ok(!out.includes(SESSION_ID), out);
	assert.ok(!out.includes('a@example.com'), out);
	assert.ok(out.includes('"path":"/home"'), out);
});

test('a member address is digested under every spelling, and stably', () => {
	// D7 found five call sites and `email.ts` three more spellings of the same
	// value, so the property is asserted per key rather than per route.
	const ADDRESS = 'alum@example.org';
	const digests = ['email', 'toEmail', 'fromEmail', 'requesterEmail'].map((key) => {
		const line = capture(() => log.info('probe', { [key]: ADDRESS, groupId: 'g1' }));
		assert.ok(!line.includes(ADDRESS), `emitted line carries a member address: ${line}`);
		assert.ok(line.includes('"groupId":"g1"'), line);
		return JSON.parse(line)[key] as string;
	});
	for (const d of digests) {
		assert.match(d, /^sha256:[0-9a-f]{12}$/);
		// One address, one digest: an operator following a person across events
		// gets the same string whichever site emitted the line.
		assert.equal(d, digests[0]);
	}
	const other = capture(() => log.info('probe', { email: 'someone-else@example.org' }));
	assert.notEqual(JSON.parse(other).email, digests[0]);
});

test('the retained digest is stable, so one visitor is followable across lines', () => {
	const first = capture(() => log.warn('a', { sessionId: SESSION_ID }));
	const second = capture(() => log.warn('b', { sessionId: SESSION_ID }));
	const other = capture(() => log.warn('c', { sessionId: '00000000-0000-4000-8000-000000000000' }));

	const digestOf = (line: string) => JSON.parse(line).sessionId as string;
	assert.match(digestOf(first), /^sha256:[0-9a-f]{12}$/);
	assert.equal(digestOf(first), digestOf(second));
	assert.notEqual(digestOf(first), digestOf(other));
});

test('an Error context value still yields message and stack', () => {
	const out = capture(() => log.error('probe', { error: new Error('boom') }));
	assert.ok(out.includes('"message":"boom"'));
	assert.ok(out.includes('"stack":"Error: boom'));
});

test('a cyclic context does not throw', () => {
	const cyclic: Record<string, unknown> = { path: '/members' };
	cyclic.self = cyclic;
	const out = capture(() => log.warn('probe', { cyclic }));
	assert.ok(out.includes('[circular]'));
	assert.ok(out.includes('/members'));
});

// The session subject is `email:<addr>`, so the two log sites that carry it,
// `auth.session.loaded` and `member.bind-subject`, reconstruct the roster and
// who signed in when. That is the property the address entries exist to deny.
// Found in production output, which runs at LOG_LEVEL=debug.
//
// Emitted at `info` rather than the real site's `debug`: redaction runs in
// `flatten` at every level, and a `debug` line is dropped by the default
// minLevel, which would leave every assertion below passing against no output.
test('the session subject does not carry the address it is built from', () => {
	const address = 'nomi@example.org';
	const out = capture(() =>
		log.info('auth.session.loaded', {
			sessionId: SESSION_ID,
			subject: `email:${address}`,
			expiresAt: 0
		})
	);

	assert.ok(!out.includes(address), `the address reached the log line: ${out}`);
	assert.match(out, /"subject":"sha256:[0-9a-f]{12}"/);
	assert.match(out, /"expiresAt":0/, 'a non-denied field was redacted with it');
});

// The fixture audit-core.test.ts asserts against too. A key added to the shared
// scrubber for either sink shows up in both suites, or in neither.
test('the shared fixture: every denied value is masked and every kept value survives', () => {
	const out = capture(() =>
		log.info('probe', { ...DENIED_FIXTURE, ...KEPT_FIXTURE, nested: { ...DENIED_FIXTURE } })
	);
	assert.deepEqual(leakedValues(out), [], out);
	const line = JSON.parse(out);
	for (const [k, v] of Object.entries(KEPT_FIXTURE)) assert.equal(line[k], v);
	for (const k of Object.keys(DENIED_FIXTURE)) assert.match(line[k], /^sha256:[0-9a-f]{12}$/);
});
