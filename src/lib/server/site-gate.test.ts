import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// Half of what the gate is worth is what it does not hand over, so the
// assertions below are as much about what a response lacks — a bundle path, the
// app's markup, a cookie — as about status codes.
//
// These drive the handler, so they cover what `handle` covers. Static files are
// answered by adapter-node's sirv before `handle` runs and are outside this
// file's reach; site-gate.ts documents that boundary and how it was measured.

const incr = mock.fn(async () => 1);
mock.module('$lib/server/redis', {
	namedExports: { redis: { incr, expire: async () => 1 } }
});

const {
	createSiteGate,
	parseGateConfig,
	issueCookieValue,
	cookieValid,
	passwordMatches,
	GATE_COOKIE_NAME
} = await import('./site-gate');

const PASSWORD = 'open sesame';
const OPTS = { secure: true, domain: '.example.org' };

function config(overrides: Record<string, string | undefined> = {}) {
	return parseGateConfig({ SITE_GATE: 'password', SITE_GATE_PASSWORD: PASSWORD, ...overrides });
}

function event(pathname: string, init: RequestInit = {}, cookie?: string) {
	const url = new URL(`https://www.example.org${pathname}`);
	return {
		url,
		route: { id: '/group/[slug]' },
		params: {},
		locals: {},
		getClientAddress: () => '203.0.113.7',
		cookies: { get: (name: string) => (name === GATE_COOKIE_NAME ? cookie : undefined) },
		request: new Request(url, init)
	};
}

// Stands in for the whole app behind the gate. If a test sees this string, the
// request reached the application; if it sees a password form, it did not.
const BEHIND = '<!doctype html><html>members directory</html>';
const resolve = async () => new Response(BEHIND, { headers: { 'content-type': 'text/html' } });

function post(body: string, origin: string | null = 'https://www.example.org') {
	const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
	if (origin) headers.origin = origin;
	return { method: 'POST', headers, body };
}

test('SITE_GATE unset is a passthrough', async () => {
	const handle = createSiteGate(parseGateConfig({}), OPTS);
	const response = await handle({ event: event('/') as never, resolve } as never);
	assert.equal(await response.text(), BEHIND);
	assert.equal(response.headers.get('set-cookie'), null);
});

test('an unrecognised SITE_GATE refuses to start rather than serving the site', () => {
	assert.throws(() => parseGateConfig({ SITE_GATE: 'yes' }), /must be 'off' or 'password'/);
});

test('SITE_GATE=password with no password refuses to start', () => {
	assert.throws(() => parseGateConfig({ SITE_GATE: 'password' }), /SITE_GATE_PASSWORD/);
});

test('a non-numeric max age refuses to start', () => {
	assert.throws(() => config({ SITE_GATE_MAX_AGE: 'a while' }), /positive whole number/);
});

test('no cookie serves the form and leaks nothing about the app', async () => {
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({ event: event('/members') as never, resolve } as never);
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.ok(body.includes('name="gate-password"'));
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');

	assert.ok(!body.includes('members directory'), 'the app rendered behind the gate');
	assert.ok(!body.includes('_app/'), 'the gate page pulls a bundle path');
	assert.ok(!body.includes('<script'), 'the gate page ships script');
});

test('/healthz stays reachable so the container healthcheck keeps passing', async () => {
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({ event: event('/healthz') as never, resolve } as never);
	assert.equal(await response.text(), BEHIND);
});

// The sign-in sender mails whatever address it is given; a closed site is
// exactly when it should not be reachable.
test('no other API path is exempt', async () => {
	const handle = createSiteGate(config(), OPTS);
	for (const path of ['/auth/magic/send', '/api/']) {
		const response = await handle({ event: event(path) as never, resolve } as never);
		assert.ok((await response.text()).includes('gate-password'), `${path} skipped the gate`);
	}
});

// Exact equality on an already-normalized pathname, so there is no prefix for a
// crafted path to sit under. `..` never reaches the comparison — the URL
// constructor resolves it first — but percent-encoding survives into
// `url.pathname`, and that is the case worth pinning.
test('the exemption is exact, so an encoded variant does not walk past it', async () => {
	const handle = createSiteGate(config(), OPTS);
	for (const path of ['/healthz/', '/%68ealthz', '/healthzz', '/healthz/sub']) {
		const response = await handle({ event: event(path) as never, resolve } as never);
		assert.ok((await response.text()).includes('gate-password'), `${path} skipped the gate`);
	}
});

test('the right password sets a cookie and redirects back to where you were', async () => {
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({
		event: event('/members?q=ravi', post(`gate-password=${encodeURIComponent(PASSWORD)}`)),
		resolve
	} as never);

	assert.equal(response.status, 303);
	assert.equal(response.headers.get('location'), '/members?q=ravi');

	const cookie = response.headers.get('set-cookie') ?? '';
	assert.ok(cookie.startsWith(`${GATE_COOKIE_NAME}=`));
	for (const flag of ['HttpOnly', 'SameSite=Lax', 'Secure', 'Domain=.example.org', 'Path=/']) {
		assert.ok(cookie.includes(flag), `cookie is missing ${flag}`);
	}
});

test('the wrong password sets no cookie', async () => {
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({
		event: event('/', post('gate-password=guess')),
		resolve
	} as never);

	assert.equal(response.headers.get('set-cookie'), null);
	assert.ok((await response.text()).includes('not right'));
});

test('a valid cookie lets the app render, still unindexed', async () => {
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({
		event: event('/members', {}, issueCookieValue(PASSWORD, 3600)),
		resolve
	} as never);

	assert.equal(await response.text(), BEHIND);
	assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('a cross-site POST cannot plant a cookie', async () => {
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({
		event: event(
			'/',
			post(`gate-password=${encodeURIComponent(PASSWORD)}`, 'https://evil.example')
		),
		resolve
	} as never);

	assert.equal(response.status, 403);
	assert.equal(response.headers.get('set-cookie'), null);
});

test('a forged mac is rejected', () => {
	const real = issueCookieValue(PASSWORD, 3600);
	const expiry = real.slice(0, real.indexOf('.'));
	assert.equal(cookieValid(`${expiry}.notthemac`, PASSWORD), false);
});

test('the signed expiry cannot be extended by hand', () => {
	const real = issueCookieValue(PASSWORD, 3600);
	const mac = real.slice(real.indexOf('.') + 1);
	const far = Math.floor(Date.now() / 1000) + 999_999;
	assert.equal(cookieValid(`${far}.${mac}`, PASSWORD), false);
});

test('an expired cookie is rejected', () => {
	const past = Date.now() - 7200_000;
	assert.equal(cookieValid(issueCookieValue(PASSWORD, 3600, past), PASSWORD), false);
});

test('rotating the password revokes every cookie already handed out', () => {
	const issued = issueCookieValue(PASSWORD, 3600);
	assert.equal(cookieValid(issued, PASSWORD), true);
	assert.equal(cookieValid(issued, 'a new password'), false);
});

test('malformed cookies are rejected rather than throwing', () => {
	for (const value of ['', '.', 'nodot', 'x.y', '.mac', '12x.mac', '-1.mac']) {
		assert.equal(cookieValid(value, PASSWORD), false, `${value} was accepted`);
	}
});

test('a guess of the wrong length neither throws nor leaks', () => {
	assert.equal(passwordMatches('', PASSWORD), false);
	assert.equal(passwordMatches('x'.repeat(4096), PASSWORD), false);
	assert.equal(passwordMatches(PASSWORD, PASSWORD), true);
});

test('guessing is metered, and a Redis outage removes the cap but not the check', async () => {
	incr.mock.resetCalls();
	const handle = createSiteGate(config(), OPTS);
	await handle({ event: event('/', post('gate-password=guess')), resolve } as never);
	assert.equal(incr.mock.callCount(), 1, 'a guess was not counted');

	incr.mock.mockImplementationOnce(async () => {
		throw new Error('redis is down');
	});
	const response = await handle({
		event: event('/', post(`gate-password=${encodeURIComponent(PASSWORD)}`)),
		resolve
	} as never);
	assert.equal(response.status, 303, 'a Redis outage blocked a correct password');
});

test('over the cap, even the right password is refused', async () => {
	incr.mock.mockImplementation(async () => 99);
	const handle = createSiteGate(config(), OPTS);
	const response = await handle({
		event: event('/', post(`gate-password=${encodeURIComponent(PASSWORD)}`)),
		resolve
	} as never);
	incr.mock.restore();

	assert.equal(response.status, 429);
	assert.equal(response.headers.get('set-cookie'), null);
});

// kit.csp never sees this page, so without its own header the one form on the
// site that takes a password ships with no policy at all.
test('the gate page carries a CSP, on first view and after a wrong password', async () => {
	const handle = createSiteGate(config(), OPTS);
	const first = await handle({ event: event('/members') as never, resolve } as never);
	const retry = await handle({
		event: event('/', post('gate-password=guess')),
		resolve
	} as never);

	for (const response of [first, retry]) {
		const csp = response.headers.get('content-security-policy') ?? '';
		const directives = new Set(csp.split(';').map((d) => d.trim()));
		assert.ok(directives.has("default-src 'none'"), `no default-src 'none' in: ${csp}`);
		assert.ok(directives.has("frame-ancestors 'none'"), `no frame-ancestors in: ${csp}`);
		assert.ok(directives.has("form-action 'self'"), `no form-action in: ${csp}`);
		assert.ok(!csp.includes('script-src'), 'the gate page runs no script and should allow none');
	}
});
