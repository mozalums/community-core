// One passkey registration and one passkey sign-in, in Chrome with a CDP virtual
// authenticator, against a running build. It also writes what the browser sent
// as the fixture src/lib/server/passkeys.test.ts verifies, so the unit tests
// check responses a real authenticator produced.
//
// Needs a build served on a `*.localhost` name (a secure context with a real
// registrable domain, so the apex-scoped cookie and the apex rpID both work):
//
//   PUBLIC_BASE_DOMAIN=f08.localhost ORIGIN=http://www.f08.localhost:5899 PORT=5899 \
//     POSTGRES_…=… REDIS_URL=… node build
//   BASE_URL=http://www.f08.localhost:5899 POSTGRES_…=… REDIS_URL=… \
//     node --import tsx scripts/f08-passkey-e2e.mts [fixture.json]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { createClient } from 'redis';
import { launchChromium } from './chromium.ts';

const BASE = process.env.BASE_URL ?? 'http://www.f08.localhost:5899';
const PREFIX = (process.env.LOREM_REDIS_PREFIX || 'lorem-prod').replace(/:$/, '');
const COOKIE = process.env.SESSION_COOKIE_NAME ?? 'community_session';
const MEMBER_ID = '6f0f8a7e-3c1d-4b2a-9e5f-0a1b2c3d4e5f';
const EMAIL = 'passkey-e2e@example.org';
const NICKNAME = 'Virtual authenticator';

const db = new pg.Client({
	host: process.env.POSTGRES_HOST,
	port: Number(process.env.POSTGRES_PORT),
	database: process.env.POSTGRES_DATABASE,
	user: process.env.POSTGRES_USER,
	password: process.env.POSTGRES_PASSWORD
});
await db.connect();
const { rows: groups } = await db.query<{ id: string }>(
	`INSERT INTO "group" (slug, name) VALUES ('example', 'Example')
	 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`
);
await db.query('DELETE FROM member WHERE id = $1', [MEMBER_ID]);
await db.query(`INSERT INTO member (id, group_id, email, name) VALUES ($1, $2, $3, 'Pat Key')`, [
	MEMBER_ID,
	groups[0].id,
	EMAIL
]);

// The session a confirmed magic link would have minted a moment ago.
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
const sid = randomUUID();
const subject = `email:${EMAIL}`;
await redis.set(
	`${PREFIX}:session:${sid}`,
	JSON.stringify({
		user: { id: subject, subject, email: EMAIL, name: '', image: '' },
		accessToken: '',
		idToken: '',
		expiresAt: Date.now() + 24 * 3600 * 1000,
		profile: {}
	}),
	{ EX: 3600 }
);

const browser = await launchChromium();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
	options: {
		protocol: 'ctap2',
		transport: 'internal',
		hasResidentKey: true,
		hasUserVerification: true,
		isUserVerified: true,
		automaticPresenceSimulation: true
	}
});

// Recorded through the router, which holds each body before the page can
// navigate away from it. The first of each kind is what the fixture keeps.
const seen: Record<string, unknown> = {};
let refuseNextOptions = false;
await context.route(/\/passkeys?$/, async (route) => {
	const req = route.request();
	if (req.method() !== 'POST') return route.continue();
	const sent = req.postDataJSON();
	const kind = new URL(req.url()).pathname.endsWith('/passkeys')
		? 'registration'
		: 'authentication';
	if (sent.step === 'options' && refuseNextOptions) {
		refuseNextOptions = false;
		return route.abort();
	}
	const res = await route.fetch();
	const body = await res.json();
	if (sent.step === 'options') seen[`${kind}Options`] ??= body;
	if (sent.step === 'verify') {
		seen[`${kind}Response`] ??= sent.response;
		seen[`${kind}Statuses`] = [...((seen[`${kind}Statuses`] as number[]) ?? []), res.status()];
	}
	return route.fulfill({ response: res, json: body });
});

const host = new URL(BASE).hostname.replace(/^www\./, '');
await context.addCookies([{ name: COOKIE, value: sid, domain: `.${host}`, path: '/' }]);
await page.goto(`${BASE}/members/${MEMBER_ID}/edit`);
await page.fill('#passkey-nickname', NICKNAME);
await page.click('text=Add a passkey');
await page.waitForSelector(`td:has-text("${NICKNAME}")`, { timeout: 15000 });
assert.ok(
	await page.isVisible('button[aria-label="Remove passkey ' + NICKNAME + '"]'),
	'no remove control'
);
assert.deepEqual(seen.registrationStatuses, [200], 'registration verify');

await context.clearCookies();
await page.goto(`${BASE}/login`);
assert.equal(
	await page.getAttribute('#login-email', 'autocomplete'),
	'username webauthn',
	'conditional mediation is offered on the email field'
);
// The virtual authenticator answers the autofill request on its own, which is
// conditional mediation completing with no button pressed.
await page.waitForURL((u) => u.pathname === '/members', { timeout: 15000 });
const signedIn = async () =>
	(await context.cookies()).some((c) => c.name === COOKIE && c.value !== sid);
assert.ok(await signedIn(), 'autofill sign-in set a session cookie');

// The button, with the autofill request refused so only the button can finish.
await context.clearCookies();
refuseNextOptions = true;
await page.goto(`${BASE}/login`);
await page.click('text=Sign in with a passkey');
await page.waitForURL((u) => u.pathname === '/members', { timeout: 15000 });
assert.ok(await signedIn(), 'button sign-in set a session cookie');
assert.deepEqual(seen.authenticationStatuses, [200, 200], 'two sign-ins verified');

const { rows } = await db.query(
	'SELECT nickname, sign_count, last_used_at FROM passkey_credential WHERE member_id = $1',
	[MEMBER_ID]
);
assert.equal(rows.length, 1);
assert.ok(rows[0].last_used_at, 'last_used_at stamped');
console.log(
	JSON.stringify({
		registered: rows[0].nickname,
		signCount: rows[0].sign_count,
		lastUsedAt: rows[0].last_used_at,
		signIns: seen.authenticationStatuses
	})
);

const out = process.argv[2];
if (out) {
	const origin = new URL(BASE).origin;
	writeFileSync(
		out,
		JSON.stringify(
			{
				rpID: host,
				origin,
				memberId: MEMBER_ID,
				email: EMAIL,
				registrationOptions: seen.registrationOptions,
				registrationResponse: seen.registrationResponse,
				authenticationOptions: seen.authenticationOptions,
				authenticationResponse: seen.authenticationResponse
			},
			null,
			'\t'
		) + '\n'
	);
}

await browser.close();
await redis.quit();
await db.end();
