import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mock, test } from 'node:test';
import type { Handle } from '@sveltejs/kit';
import { loadSkinDir, skinDir, skinModuleSource } from '../../../../../lib/skin/load';

// A signed-out visitor asking for /members/<name> must learn nothing about the
// name: the real hooks.server gate answers before any route or query runs, so a
// member's username and a name nobody holds get the same login redirect. Every
// database and Redis read is a recorded stub, and none may be reached.

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

const reached: string[] = [];
mock.module('$lib/server/redis', {
	namedExports: {
		redis: {
			get: async () => (reached.push('redis'), null),
			del: async () => 0
		}
	}
});
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string) => (reached.push(text), { rows: [] }),
		withTransaction: async () => reached.push('transaction')
	}
});
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

const { handle } = await import('../../../../../hooks.server');
const { reroute } = await import('../../../../../hooks');
const { DEFAULT_GROUP_SLUG } = await import('../../../../../lib/group-nav');

// What the browser gets for `path` with no session cookie. The route id is the
// one SvelteKit matches for any /members/<segment>, which is all the gate sees.
async function guest(path: string) {
	const url = new URL(`https://example.org${path}`);
	const routed = reroute({ url } as never) ?? path;
	assert.equal(routed, `/group/${DEFAULT_GROUP_SLUG}${path}`, `${path} did not reroute`);
	const event = {
		url,
		request: new Request(url),
		route: { id: '/group/[slug]/members/[id]' },
		params: { slug: DEFAULT_GROUP_SLUG, id: path.split('/')[2] },
		locals: {},
		cookies: { get: () => undefined, delete: () => {} },
		getClientAddress: () => '198.51.100.7'
	};
	let routeRan = false;
	try {
		const res = await handle({
			event: event as never,
			resolve: async () => ((routeRan = true), new Response('profile'))
		});
		return { status: res.status, location: res.headers.get('location'), routeRan };
	} catch (e) {
		const r = e as { status: number; location: string };
		return { status: r.status, location: r.location, routeRan };
	}
}

test('F11 R5: signed out, an existing username and a missing one get the same login redirect', async () => {
	reached.length = 0;
	const held = await guest('/members/ada-lovelace');
	const missing = await guest('/members/no-such-name');
	assert.equal(held.status, 303);
	assert.equal(held.status, missing.status);
	const shape = (r: typeof held, path: string) =>
		r.location?.replace(encodeURIComponent(path), '<path>');
	assert.equal(held.location, `/login?callbackUrl=${encodeURIComponent('/members/ada-lovelace')}`);
	assert.equal(
		shape(held, '/members/ada-lovelace'),
		shape(missing, '/members/no-such-name'),
		'the two redirects differ beyond the path asked for'
	);
	assert.equal(held.routeRan || missing.routeRan, false, 'a signed-out request reached the route');
	assert.deepEqual(reached, [], 'a signed-out request reached the database');
});

test('F11 R4: the clean-URL reroute carries a username and its sub-routes', () => {
	for (const path of [
		'/members/ada-lovelace',
		'/members/ada-lovelace/edit',
		'/members/ada-lovelace/star'
	]) {
		assert.equal(
			reroute({ url: new URL(`https://example.org${path}`) } as never),
			`/group/${DEFAULT_GROUP_SLUG}${path}`
		);
	}
});
