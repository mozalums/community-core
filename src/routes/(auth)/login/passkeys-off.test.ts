import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register, registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isHttpError } from '@sveltejs/kit';
import { compile } from 'svelte/compiler';
import { loadSkinDir, skinDir, skinModuleSource } from '../../../lib/skin/load';

// A skin with `auth.passkeys: false`: every passkey endpoint answers 404 and
// the login page renders no passkey control. The skin module is the default
// skin's, as the Vite plugin would serve it, with only that key changed.

const loaded = loadSkinDir(skinDir());
const off = { ...loaded, skin: { ...loaded.skin, auth: { passkeys: false } } };

register(
	'data:text/javascript,' +
		encodeURIComponent(`
  const stubs = {
    '$skin/skin.yaml': ${JSON.stringify(skinModuleSource(off))},
    '$env/dynamic/private': 'export const env = process.env;',
    '$env/dynamic/public': 'export const env = process.env;',
    '$app/environment': 'export const dev = false; export const browser = false; export const building = false;',
    '$app/forms': 'export const enhance = () => ({ destroy() {} });'
  };
  export async function resolve(specifier, context, next) {
    if (specifier in stubs) return {
      url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]),
      shortCircuit: true
    };
    return next(specifier, context);
  }`)
);

registerHooks({
	load(url, context, nextLoad) {
		if (!url.endsWith('.svelte')) return nextLoad(url, context);
		const filename = fileURLToPath(url);
		const { js } = compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' });
		return { format: 'module', source: js.code, shortCircuit: true };
	}
});

mock.module('$lib/server/magic-link', {
	namedExports: {
		sendMagicLink: async () => ({ ok: true }),
		mintEmailSession: async () => 'never',
		normalizeEmail: (e: string) => e,
		signInRateLimited: async () => false
	}
});
mock.module('$lib/server/redis', { namedExports: { redis: {} } });
mock.module('$lib/server/postgres', { namedExports: { query: async () => ({ rows: [] }) } });
mock.module('$lib/server/gravatar', { namedExports: { refreshOnSignIn: () => {} } });
mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => ({ id: 'g' }) } });
mock.module('$lib/server/members', {
	namedExports: { getMemberById: async () => ({ id: 'm' }), canEditMember: () => true }
});

const source = (p: string) => pathToFileURL(resolve(p)).href;
const signIn = await import(source('src/routes/(auth)/auth/passkey/+server.ts'));
const own = await import(source('src/routes/group/[slug]/members/[id]/passkeys/+server.ts'));
const login = await import(source('src/routes/(auth)/login/+page.server.ts'));
const { PASSKEYS_ENABLED } = await import(source('src/lib/server/passkeys.ts'));
const { render } = await import('svelte/server');
const { default: LoginPage } = await import(source('src/routes/(auth)/login/+page.svelte'));

const memberId = '00000000-0000-4000-8000-000000000001';
const session = {
	user: { email: 'a@example.org', subject: 'email:a@example.org' },
	expiresAt: Date.now() + 864e5
};
const event = (method: string, path: string, body?: unknown) =>
	({
		params: { slug: 'example', id: memberId },
		url: new URL(`https://www.example.org${path}`),
		request: new Request(`https://www.example.org${path}`, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		}),
		locals: { sessionId: 'sid', session, user: session.user },
		cookies: { set() {} },
		getClientAddress: () => '198.51.100.7'
	}) as never;

async function statusOf(run: () => Promise<Response>): Promise<number> {
	try {
		return (await run()).status;
	} catch (e) {
		if (isHttpError(e)) return e.status;
		throw e;
	}
}

test('F8 R5: with auth.passkeys false the skin switch reads off', () => {
	assert.equal(PASSKEYS_ENABLED, false);
});

test('F8 R5: with auth.passkeys false every passkey route is a 404', async () => {
	const at = `/members/${memberId}/passkeys`;
	for (const [name, run] of [
		['sign-in options', () => signIn.POST(event('POST', '/auth/passkey', { step: 'options' }))],
		[
			'sign-in verify',
			() => signIn.POST(event('POST', '/auth/passkey', { step: 'verify', response: {} }))
		],
		['list', () => own.GET(event('GET', at))],
		['register', () => own.POST(event('POST', at, { step: 'options' }))],
		['remove', () => own.DELETE(event('DELETE', at, { id: 'AAAA' }))]
	] as const) {
		assert.equal(await statusOf(run), 404, name);
	}
});

test('F8 R5: with auth.passkeys false the login page shows no passkey control', async () => {
	const data = await login.load({
		url: new URL('https://www.example.org/login'),
		locals: { user: null }
	} as never);
	assert.equal(data.passkeys, false);
	const html = render(LoginPage, {
		props: { data: { ...data, user: null }, form: null } as never
	}).body;
	assert.doesNotMatch(html, /passkey/i, 'the login page mentions passkeys');
	assert.match(html, /autocomplete="email"/);

	// The same template with the switch on, so the assertion above is about the switch.
	const on = render(LoginPage, {
		props: { data: { ...data, passkeys: true, user: null }, form: null } as never
	}).body;
	assert.match(on, /Sign in with a passkey/);
	assert.match(on, /autocomplete="username webauthn"/);
});

mock.module('$lib/server/schema', { namedExports: { ensureSchema: async () => {} } });
mock.module('$lib/server/audit', { namedExports: { startAuditPruner: () => {} } });
const { with_request_store } = await import(source('node_modules/@sveltejs/kit/src/exports/internal/server.js'));
const { handle } = await import(source('src/hooks.server.ts'));
test('review: F8 R5 disabled passkeys return 404 through the shipped hooks for guests', async () => {
  const e = event('GET', `/members/${memberId}/passkeys`) as any;
  e.locals = {};
  e.route = { id: '/group/[slug]/members/[id]/passkeys' };
  e.cookies = { get: () => undefined, set() {}, delete() {} };
  let actual;
  let location;
  try {
    const state = { tracing: { record_span: ({ fn }: any) => fn({}) } };
    const res = await with_request_store({ event: e, state } as any, () => handle({ event: e, resolve: (at: never) => own.GET(at) } as never));
    actual = res.status;
    location = res.headers.get('location');
  } catch (e) {
    if (!(e as any).status) throw e;
    actual = (e as any).status;
    location = (e as any).location;
  }
  console.log(JSON.stringify({ actual, location }));
  assert.equal(actual, 404);
});

test('F8 R5: with auth.passkeys false a guest gets 404 through the hooks for every method and URL form', async () => {
	const state = { tracing: { record_span: ({ fn }: { fn: (s: object) => unknown }) => fn({}) } };
	for (const path of [`/members/${memberId}/passkeys`, `/group/example/members/${memberId}/passkeys`]) {
		for (const [method, handler, body] of [
			['GET', own.GET, undefined],
			['POST', own.POST, { step: 'options' }],
			['DELETE', own.DELETE, { id: 'AAAA' }]
		] as const) {
			const e = event(method, path, body) as unknown as Record<string, unknown>;
			e.locals = {};
			e.route = { id: '/group/[slug]/members/[id]/passkeys' };
			e.cookies = { get: () => undefined, set() {}, delete() {} };
			let reached = false;
			const res: Response = await with_request_store({ event: e, state } as never, () =>
				handle({
					event: e,
					resolve: (at: never) => {
						reached = true;
						return handler(at);
					}
				} as never)
			);
			assert.equal(res.status, 404, `${method} ${path}`);
			assert.ok(!reached, `${method} ${path} reached method dispatch`);
			assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${method} ${path}`);
			assert.equal(res.headers.get('x-frame-options'), 'DENY', `${method} ${path}`);
			assert.equal(res.headers.get('cache-control'), 'private, no-store, max-age=0', `${method} ${path}`);
		}
	}
});

const { render_endpoint } = await import(
  source('node_modules/@sveltejs/kit/src/runtime/server/endpoint.js')
);

test('review: F8 R5 disabled passkeys return 404 before HTTP method dispatch', async () => {
  const state = { tracing: { record_span: ({ fn }: any) => fn({}) } };
  const actual: Record<string, number> = {};
  const expected: Record<string, number> = {};
  for (const [path, routeId, endpoint] of [
    [`/members/${memberId}/passkeys`, '/group/[slug]/members/[id]/passkeys', own],
    [`/group/example/members/${memberId}/passkeys`, '/group/[slug]/members/[id]/passkeys', own],
    ['/auth/passkey', '/(auth)/auth/passkey', signIn]
  ] as const) {
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
      const e = event(method, path) as any;
      e.locals = {};
      e.route = { id: routeId };
      e.cookies = { get: () => undefined, set() {}, delete() {} };
      const label = `${method} ${path}`;
      actual[label] = await statusOf(() => with_request_store({ event: e, state } as any, () =>
        handle({
          event: e,
          resolve: (at: any) => render_endpoint(at, state, endpoint, { prerender_default: false })
        } as any)
      ));
      expected[label] = 404;
    }
  }
  console.log(JSON.stringify(actual));
  assert.deepEqual(actual, expected);
});
