import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { Handle } from '@sveltejs/kit';
import { loadSkinDir, skinDir, skinModuleSource } from '../skin/load';

// The real session-store, hooks.server and sign-in action are what load here:
// the override has to be seen arriving at `cookies.set` and `cookies.get`, and
// a stub of SESSION_COOKIE_NAME would prove only that the stub was read. The
// SvelteKit virtual modules resolve to stand-ins that read process.env, which is
// where adapter-node fills `$env/dynamic/private` from in production. The skin
// modules are what the Vite plugin serves for the same directory.

const OVERRIDE = 'mz_next_sid';
// Spelled in two halves so the sweep below does not count this file.
const LEGACY = ['_lorem', 's'].join('_');

process.env.SESSION_COOKIE_NAME = OVERRIDE;
delete process.env.SITE_GATE;

const skin = loadSkinDir(skinDir());

register(
	'data:text/javascript,' +
		encodeURIComponent(`
  const stubs = {
    '$skin/skin.yaml': ${JSON.stringify(skinModuleSource(skin))},
    '$skin/skin.yaml?raw': ${JSON.stringify(`export default ${JSON.stringify(skin.text)};`)},
    '$env/dynamic/private': 'export const env = process.env;',
    '$env/dynamic/public': 'export const env = process.env;',
    '$app/environment': 'export const dev = false; export const browser = false; export const building = false;'
  };
  export async function resolve(specifier, context, next) {
    if (specifier in stubs) return {
      url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]),
      shortCircuit: true
    };
    return next(specifier, context);
  }
`),
	import.meta.url
);

const SESSION_ID = '6f1b2c3d-4e5a-4b7c-8d9e-0a1b2c3d4e5f';
const live = { user: { subject: 'email:nomi@example.org' }, expiresAt: Date.now() + 60_000 };

mock.module('$lib/server/redis', {
	namedExports: {
		redis: {
			get: async (key: string) => (key.endsWith(`:session:${SESSION_ID}`) ? live : null),
			del: async () => 0
		}
	}
});
// Kit's own `sequence` reads a request store that only its server runtime
// opens. This one composes the same handlers in the same order without it.
mock.module('@sveltejs/kit/hooks', {
	namedExports: {
		sequence:
			(...handlers: Handle[]): Handle =>
			({ event, resolve }) =>
				handlers.reduceRight<(e: typeof event) => Response | Promise<Response>>(
					(next, handler) => (e) => handler({ event: e, resolve: next }),
					resolve
				)(event)
	}
});
mock.module('$lib/server/schema', { namedExports: { ensureSchema: async () => {} } });
mock.module('$lib/server/audit', { namedExports: { startAuditPruner: () => {} } });
mock.module('$lib/server/gravatar', { namedExports: { refreshOnSignIn: () => {} } });
mock.module('$lib/server/magic-link', {
	namedExports: {
		peekMagicToken: async () => null,
		consumeMagicToken: async () => ({ email: 'nomi@example.org', callbackUrl: '/members' }),
		mintEmailSession: async () => SESSION_ID,
		sendMagicLink: async () => ({ ok: true })
	}
});

const { DEFAULT_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME, parseSessionCookieName } =
	await import('./session-store');
const { GATE_COOKIE_NAME } = await import('./site-gate');
const { log } = await import('./log');
const { handle } = await import('../../hooks.server');
const { actions } = await import('../../routes/(auth)/auth/magic/+page.server');

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

function refusal(value: string): string {
	try {
		parseSessionCookieName({ SESSION_COOKIE_NAME: value });
	} catch (e) {
		return (e as Error).message;
	}
	assert.fail(`'${value}' was accepted as a session cookie name`);
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)]
	);
}

test('an unset SESSION_COOKIE_NAME resolves to community_session', () => {
	assert.equal(DEFAULT_SESSION_COOKIE_NAME, 'community_session');
	assert.equal(parseSessionCookieName({}), 'community_session');
	assert.equal(parseSessionCookieName({ SESSION_COOKIE_NAME: undefined }), 'community_session');
});

test('configured names must be unmodified cookie tokens', async (t) => {
  for (const value of ['', '  ', ' session', 'session ', 'session\n', '\t']) {
    await t.test(JSON.stringify(value), () => {
      assert.throws(
        () => parseSessionCookieName({ SESSION_COOKIE_NAME: value }),
        (error: unknown) => error instanceof Error &&
          /SESSION_COOKIE_NAME/.test(error.message) &&
          /RFC 6265 cookie token/.test(error.message),
        `accepted invalid configured name ${JSON.stringify(value)}`
      );
    });
  }
});

test('the exported SESSION_COOKIE_NAME is the environment value', () => {
	assert.equal(SESSION_COOKIE_NAME, OVERRIDE);
});

test('no cookie name in src contains lorem outside the redaction deny-list', () => {
	// Every cookie this app has named after the old brand was snake_case under
	// that word, which is the form no env var, Redis prefix or hostname takes.
	const holders = sourceFiles('src').filter((file) =>
		/lorem_[a-z]/.test(readFileSync(file, 'utf8'))
	);
	assert.deepEqual(holders, [join('src', 'lib', 'server', 'redact.ts')]);
	assert.ok(!GATE_COOKIE_NAME.includes('lorem'));
});

test('sign-in sets the session cookie under the configured name', async () => {
	const set: { name: string; value: string }[] = [];
	const fd = new FormData();
	fd.set('token', 'tok_c0ffee');
	const url = new URL('https://new.example.org/auth/magic');
	await assert.rejects(
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(actions as any).confirm({
			request: new Request(url, { method: 'POST', body: fd }),
			cookies: { set: (name: string, value: string) => set.push({ name, value }) },
			url,
			getClientAddress: () => '203.0.113.7'
		}),
		(e: { status?: number; location?: string }) => e.status === 303 && e.location === '/members'
	);
	assert.deepEqual(set, [{ name: OVERRIDE, value: SESSION_ID }]);
});

test('the session hook reads the session cookie under the configured name', async () => {
	// A jar holding the session id under every name but the configured one must
	// come out signed out; the same id under the configured name signs in.
	async function request(jar: Record<string, string>) {
		const asked: string[] = [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const event: any = {
			url: new URL('https://new.example.org/'),
			request: new Request('https://new.example.org/'),
			route: { id: '/' },
			locals: {},
			cookies: {
				get: (name: string) => {
					asked.push(name);
					return jar[name];
				},
				delete: () => {}
			}
		};
		await handle({ event, resolve: async () => new Response('ok') });
		return { asked, locals: event.locals };
	}

	const foreign = await request({ [LEGACY]: SESSION_ID, community_session: SESSION_ID });
	assert.ok(foreign.asked.includes(OVERRIDE), 'the hook never asked for the configured name');
	assert.ok(!foreign.asked.includes(LEGACY), 'the hook still reads the old cookie name');
	assert.equal(foreign.locals.sessionId, null, 'a cookie under another name signed someone in');

	const own = await request({ [OVERRIDE]: SESSION_ID });
	assert.equal(own.locals.sessionId, SESSION_ID);
	assert.equal(own.locals.user?.subject, 'email:nomi@example.org');
});

test('a name that is not a cookie token is refused', () => {
	for (const bad of [
		'community session',
		'community;s',
		'community=s',
		'community"s',
		'community/s',
		'sésame',
		'a\tb'
	]) {
		const message = refusal(bad);
		assert.match(message, /SESSION_COOKIE_NAME/, bad);
		assert.match(message, /RFC 6265 cookie token/, bad);
	}
});

test('a name beginning __Host- is refused', () => {
	for (const bad of ['__Host-community', '__host-community']) {
		const message = refusal(bad);
		assert.match(message, /SESSION_COOKIE_NAME/, bad);
		assert.match(message, /Domain attribute/, bad);
	}
	assert.equal(parseSessionCookieName({ SESSION_COOKIE_NAME: '__Secure-community' }), '__Secure-community');
});

test('the site gate cookie name is refused', () => {
	const message = refusal(GATE_COOKIE_NAME);
	assert.match(message, /SESSION_COOKIE_NAME/);
	assert.match(message, /site gate/);
});

test('a name differing from a reserved one only by case is a different cookie', () => {
	assert.equal(parseSessionCookieName({ SESSION_COOKIE_NAME: 'Community_Gate' }), 'Community_Gate');
});

for (const name of ['community_utm', 'community_cohort']) {
  test(`reserved marketing cookie name ${name} is refused`, () => {
    assert.throws(
      () => parseSessionCookieName({ SESSION_COOKIE_NAME: name }),
      (error: unknown) => error instanceof Error &&
        /SESSION_COOKIE_NAME/.test(error.message) &&
        /marketing|reserved|already uses/.test(error.message),
      `accepted a name written by the marketing hook: ${name}`
    );
  });
}

test('every cookie the hooks set for a guest is refused as the session cookie name', async () => {
	// Driven from the response rather than from a list, so a cookie added to the
	// hooks without a reservation fails here.
	const url = new URL('https://new.example.org/?utm_source=review');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const event: any = {
		url,
		request: new Request(url),
		route: { id: '/' },
		locals: {},
		cookies: { get: () => undefined, delete: () => {} }
	};
	const response = await handle({ event, resolve: async () => new Response('ok') });
	const names = response.headers.getSetCookie().map((line) => line.slice(0, line.indexOf('=')));
	assert.deepEqual(names.sort(), ['community_cohort', 'community_utm']);
	for (const name of names) {
		const message = refusal(name);
		assert.match(message, /SESSION_COOKIE_NAME/, name);
		assert.match(message, /already uses that cookie name/, name);
	}
});

test('docs/configuration.md documents SESSION_COOKIE_NAME beside the hostname variables', () => {
	const readme = readFileSync('docs/configuration.md', 'utf8');
	const features = readFileSync('docs/features.md', 'utf8');
	const flat = (text: string) => text.replace(/\s+/g, ' ');

	const hostname = readme.split(/^## Hostname \(`PUBLIC_BASE_DOMAIN` \+ `ORIGIN`\)$/m)[1];
	assert.ok(hostname, 'the Hostname section is gone');
	const heading = /^### Session cookie name \(`SESSION_COOKIE_NAME`\)$/m;
	const section = flat(hostname.split(/^## /m)[0].split(heading)[1] ?? '');
	assert.ok(section, 'no SESSION_COOKIE_NAME subsection inside the Hostname section');

	const expected: [string, RegExp][] = [
		['a table row carrying the default', /\| `SESSION_COOKIE_NAME` \| [^|]*default `community_session` \|/],
		['what the variable does', /The cookie that carries the session id/],
		['two deployments need two names', /Two deployments under one apex must set different names/],
		['the default replaced the old name', new RegExp(`The default replaced \`${LEGACY}\``)],
		['changing the name signs everyone out', /Changing the name on a running deployment signs everyone out, once\*\*, as moving the apex does/],
		['the first deploy signs every member out', new RegExp(`first deploy of a build carrying this variable is such a change and signs every member out once, because the default is no longer \`${LEGACY}\``)],
		['a blank value is refused', /Only a variable that is absent takes the default/],
		['the app\'s own cookie names are refused', /`community_gate`.*`community_utm` or `community_cohort`/]
	];
	for (const [what, pattern] of expected) assert.match(section, pattern, what);

	const signIn = flat(features).match(/- `\/auth\/magic` — .*?mints a session in \*\*Redis\*\*, carried by the cookie ([^.]*)\./);
	assert.ok(signIn, 'the /auth/magic description no longer says which cookie carries the session');
	assert.match(signIn[1], /`SESSION_COOKIE_NAME`/);
	assert.ok(
		!readme.split(heading)[0].includes(LEGACY) && !features.includes(LEGACY),
		'the docs name the old cookie outside the SESSION_COOKIE_NAME section'
	);
});

test('a log context keyed by the configured cookie name is redacted', () => {
	const out = capture(() =>
		log.warn('auth.session.miss', { [OVERRIDE]: SESSION_ID, path: '/members' })
	);
	assert.match(out, /"path":"\/members"/);
	assert.match(out, new RegExp(`"${OVERRIDE}":"sha256:[0-9a-f]{12}"`));
	assert.ok(!out.includes(SESSION_ID), 'the session id reached the log stream');
});

test('the default and the old cookie name stay redacted', () => {
	const out = capture(() =>
		log.warn('auth.session.miss', { community_session: SESSION_ID, [LEGACY]: SESSION_ID })
	);
	assert.match(out, /"community_session":"sha256:/);
	assert.ok(!out.includes(SESSION_ID), 'the session id reached the log stream');
});
