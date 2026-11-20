import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, mock } from 'node:test';
import type { Handle } from '@sveltejs/kit';

// The property under test: every surface gets the baseline, not just the ones
// someone remembered. `noStoreGated` and `staticCache` in hooks.server.ts are
// both route-conditional, so "the app sets a header" is a claim about a route,
// not about the app — each of the four surfaces below is driven through the
// real handler and asserted on the Response it returns.
//
// Two of the four are the route module's own output rather than a stand-in:
// /avatar/<id> serves whatever MIME the upload stored, and the member star
// toggle is the JSON endpoint. Their dependencies are mocked, never reached.

const getAvatarByPublicId = mock.fn(async () => ({
	bytes: new Uint8Array([0x3c, 0x21]),
	// Deliberately not an image: this is what `nosniff` is for. The upload path
	// allowlists three image types, so a row like this means that control was
	// bypassed or predates it — and the header is what stops the browser
	// rendering the bytes as a document anyway.
	contentType: 'text/html',
	updatedAt: new Date('2026-08-10T00:00:00Z'),
	// An upload, so serving it triggers no background Gravatar fetch.
	source: 'upload' as const,
	email: 'stored@example.com',
	fetchedAt: null,
	lastModified: null
}));
const recordGravatar = mock.fn(async () => {});
// Node's module mocking replaces the whole module, so every export the
// subject imports has to appear here or the import throws at load.
const getAvatarByEmail = mock.fn(async () => null);
mock.module('$lib/server/avatars', {
	namedExports: { getAvatarByPublicId, recordGravatar, getAvatarByEmail }
});

mock.module('$lib/server/redis', {
	namedExports: { redis: { incr: async () => 1, expire: async () => 1 } }
});
mock.module('$lib/server/route-guards', {
	namedExports: {
		requireDirectoryAccess: async () => ({ group: { id: 'g' }, user: { subject: 'email:a@b.c' } })
	}
});
mock.module('$lib/server/members', {
	namedExports: { getMemberById: async () => ({ id: AVATAR_ID }) }
});
mock.module('$lib/server/stars', {
	namedExports: { addStar: async () => {}, removeStar: async () => {} }
});

const {
	securityHeaders,
	referrerPolicyFor,
	REFERRER_POLICY,
	AUTH_REFERRER_POLICY,
	SECURITY_HEADERS
} = await import('./security-headers');
const { GET: avatarGET } = await import('../../routes/avatar/[id]/+server');
const { POST: starPOST } = await import('../../routes/group/[slug]/members/[id]/star/+server');

const AVATAR_ID = '3f6b1a2c-9d84-4c1e-8f37-6b2ad5c90e11';

function event(pathname: string, routeId: string, init: RequestInit = {}) {
	const url = new URL(`https://www.lorem.host${pathname}`);
	return {
		url,
		route: { id: routeId },
		params: { id: AVATAR_ID },
		locals: { sessionId: null, session: null, user: null, marketing: { cohort: '', utm: {} } },
		getClientAddress: () => '203.0.113.7',
		cookies: { get: () => undefined },
		request: new Request(url, init)
	};
}

// Each surface is built fresh per call: a Request body is readable once, so a
// shared event would answer the second caller with a parse error.
type Surface = {
	name: string;
	build: () => { event: ReturnType<typeof event>; render: () => Promise<Response> };
};

const HTML = { headers: { 'content-type': 'text/html' } };

const SURFACES: Surface[] = [
	{
		name: 'public page',
		build: () => ({
			event: event('/', '/group/[slug]'),
			render: async () => new Response('<!doctype html><html></html>', HTML)
		})
	},
	{
		name: 'gated page',
		build: () => ({
			event: event('/members', '/group/[slug]/members'),
			// The cache-control value `noStoreGated` sets on this route. It is here
			// to prove the baseline is additive: a header the route already owns has
			// to survive the handler that runs outside it.
			render: async () =>
				new Response('<!doctype html><html></html>', {
					headers: { ...HTML.headers, 'cache-control': 'private, no-store, max-age=0' }
				})
		})
	},
	{
		name: '/avatar/<id>',
		build: () => {
			const e = event(`/avatar/${AVATAR_ID}`, '/avatar/[id]');
			return { event: e, render: async () => avatarGET(e as never) };
		}
	},
	{
		name: 'JSON endpoint',
		build: () => {
			const e = event(`/members/${AVATAR_ID}/star`, '/group/[slug]/members/[id]/star', {
				method: 'POST'
			});
			return { event: e, render: async () => starPOST(e as never) };
		}
	}
];

function through(surface: Surface): Promise<Response> {
	const { event: e, render } = surface.build();
	return Promise.resolve(
		(securityHeaders as Handle)({ event: e, resolve: () => render() } as never)
	) as Promise<Response>;
}

for (const surface of SURFACES) {
	test(`${surface.name} carries the security-header baseline`, async () => {
		const response = await through(surface);
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
			assert.equal(response.headers.get(name), value, `${surface.name} is missing ${name}`);
		}
		assert.equal(response.headers.get('referrer-policy'), REFERRER_POLICY);
	});
}

test('the avatar bytes keep their stored content-type, with nosniff over it', async () => {
	const response = await through(SURFACES[2]);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'text/html');
	assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('the JSON endpoint still answers with JSON', async () => {
	const response = await through(SURFACES[3]);
	assert.equal(response.headers.get('content-type'), 'application/json');
	assert.equal(await response.text(), '{"ok":true,"starred":true}');
});

test('the gated page keeps the cache-control its own route set', async () => {
	const response = await through(SURFACES[1]);
	assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
});

test('a magic-link URL never sends a path in its referrer', async () => {
	const response = await through({
		name: 'magic link',
		build: () => {
			// The token is in the query string, so the referrer is the leak.
			const e = event('/auth/magic?token=live-token-value', '/(auth)/auth/magic');
			return { event: e, render: async () => new Response('<!doctype html><html></html>', HTML) };
		}
	});
	assert.equal(response.headers.get('referrer-policy'), AUTH_REFERRER_POLICY);
	assert.equal(AUTH_REFERRER_POLICY, 'strict-origin');
});

// The confirm button on /auth/magic is a form POST, and Fetch consults the
// referrer policy when it builds the Origin header for any method that is not
// GET or HEAD. Under `no-referrer` the browser sends `Origin: null`, which
// SvelteKit's csrf.checkOrigin rejects, so this page cannot both hide its
// referrer completely and accept its own form. Measured in Chrome: no-referrer
// yields `Origin: null`, strict-origin yields the real origin.
test('no policy on a page with a form action can be no-referrer', () => {
	const withForms = ['/auth/magic', '/auth', '/login'];
	for (const path of withForms) {
		assert.notEqual(
			referrerPolicyFor(path),
			'no-referrer',
			`${path} posts a form, so no-referrer would send Origin: null and fail the CSRF check`
		);
	}
});

// The exemption strict-origin relies on applies unless the request downgrades
// https to http. Anything outside that family is a regression waiting to
// happen, so the family membership is the assertion rather than the value.
test('the auth policy stays in the family that preserves Origin', () => {
	assert.ok(
		['strict-origin', 'strict-origin-when-cross-origin', 'same-origin', 'origin'].includes(
			AUTH_REFERRER_POLICY
		),
		`${AUTH_REFERRER_POLICY} is not known to preserve the Origin header on a POST`
	);
});

test('no handler sets a second Content-Security-Policy', async () => {
	// The page CSP comes from `kit.csp` and from nowhere else. A copy here would
	// be a second value on the same header, on exactly the surfaces that already
	// have one.
	assert.ok(!('content-security-policy' in SECURITY_HEADERS));
	for (const surface of SURFACES) {
		const response = await through(surface);
		assert.equal(response.headers.get('content-security-policy'), null);
	}
});

test('the page CSP names what the app actually loads', async () => {
	const { default: config } = await import('../../../svelte.config.js');
	const csp = config.kit?.csp;
	const directives = csp?.directives ?? {};

	// Nonces, not a hand-written allowance: SvelteKit stamps its own hydration
	// bootstrap and app.html's pre-paint theme script per response.
	assert.equal(csp?.mode, 'nonce');
	assert.ok(!directives['script-src']?.includes('unsafe-inline'));

	assert.deepEqual(directives['frame-ancestors'], ['none']);
	// Gravatar.svelte falls back to gravatar.com directly when a member has no
	// uploaded photo, so the policy has to name it.
	assert.ok(directives['img-src']?.includes('https://www.gravatar.com'));
	// The faces are self-hosted; a font CDN in here would mean they stopped being.
	assert.deepEqual(directives['font-src'], ['self']);
	// The suite runs on the default skin, which sets no `analytics` block, so
	// the policy names no third-party script or beacon origin at all.
	for (const d of ['script-src', 'connect-src', 'img-src'] as const) {
		assert.ok(
			!directives[d]?.some((s) => String(s).includes('usefathom')),
			`${d} allows an analytics origin no skin asked for`
		);
	}
});

test('the CSP still covers the inline handler Svelte emits for event replay', async () => {
	// Svelte stamps `onerror="this.__e=event"` on any <img> carrying an error
	// handler — Gravatar.svelte, on every row of the members directory — so it
	// can replay an error that fired before hydration. An inline handler
	// attribute takes neither a nonce nor a plain hash, so the policy names its
	// body under 'unsafe-hashes'. Compile the same markup this Svelte version
	// would: if an upgrade changes that body, this fails here rather than in a
	// browser, as an avatar that never advances past the broken-image glyph.
	const { compile } = await import('svelte/compiler');
	const { js } = compile('<img alt="" onerror={() => {}} />', { generate: 'server' });
	const body = js.code.match(/onerror="([^"]+)"/)?.[1];
	assert.equal(body, 'this.__e=event');

	const { default: config } = await import('../../../svelte.config.js');
	const scriptSrc = config.kit?.csp?.directives?.['script-src'] ?? [];
	const hash = `sha256-${createHash('sha256').update(body).digest('base64')}`;
	assert.ok(
		scriptSrc.some((source) => source === hash),
		`script-src does not name ${hash}`
	);
	// The pair travels together: the hash alone is ignored for an attribute, and
	// 'unsafe-hashes' alone allows nothing.
	assert.ok(scriptSrc.includes('unsafe-hashes'));
});

// nginx answers some requests itself (redirects, 413, 502) and stamps its
// version and distribution on each unless told not to. Sibling server blocks
// inherit nothing from each other, so every block has to say it.
test('every nginx server block turns server_tokens off', async () => {
	const { readdir, readFile } = await import('node:fs/promises');
	const root = new URL('../../../', import.meta.url);
	// Core's template, plus any community's own vhosts, which it keeps in its
	// skin directory under deploy/nginx and the same nginx serves.
	const dirs = [new URL('deploy/nginx/', root)];
	const skins = new URL('skin', root);
	for (const name of await readdir(skins)) {
		const own = new URL(`${skins.href}/${name}/deploy/nginx/`);
		if (await readdir(own).then(() => true, () => false)) dirs.push(own);
	}
	const missing: string[] = [];
	let blocks = 0;
	let declared = 0;
	for (const dir of dirs) {
		for (const name of (await readdir(dir)).filter((n) => n.endsWith('.conf'))) {
			const source = (await readFile(new URL(name, dir), 'utf8')).replace(/#.*$/gm, '');
			// Every block names its hosts once, so a block the `^server {` match
			// misses (indented, say) shows up as a difference between the counts.
			declared += source.match(/^\s*server_name\s/gm)?.length ?? 0;
			for (const match of source.matchAll(/^server\s*\{/gm)) {
				let depth = 0;
				let end = match.index + match[0].length - 1;
				do {
					if (source[end] === '{') depth++;
					else if (source[end] === '}') depth--;
					end++;
				} while (depth > 0 && end < source.length);
				const body = source.slice(match.index, end);
				blocks++;
				if (!/^\s*server_tokens\s+off\s*;/m.test(body)) {
					missing.push(`${name}: ${/server_name\s+([^;]+);/.exec(body)?.[1] ?? '?'}`);
				}
			}
		}
	}
	assert.ok(blocks >= 3, `found ${blocks} server blocks; the template lost some`);
	assert.equal(blocks, declared, 'the parser lost some server blocks');
	assert.deepEqual(missing, [], 'these blocks advertise the nginx version');
});
