import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sequence } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { APP_APEX_DOMAIN } from '$lib/site';
import { GROUP_GATED_ROUTE } from '$lib/group-nav';
import { log } from '$lib/server/log';
import { assertSkinAtBoot } from '$lib/skin/load';
import builtSkin from '$skin/skin.yaml?raw';
import { assertMailConfig } from '$lib/server/mail';
import { PASSKEYS_ENABLED } from '$lib/server/passkeys';
import { ensureSchema } from '$lib/server/schema';
import { startAuditPruner } from '$lib/server/audit';
import { securityHeaders } from '$lib/server/security-headers';
import {
	RETIRED_COOKIE_NAMES,
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS,
	getSession,
	type SessionData
} from '$lib/server/session-store';
import { createSiteGate, parseGateConfig } from '$lib/server/site-gate';

function setLocalsSession(event: Parameters<Handle>[0]['event'], session: SessionData | null) {
	if (!session) {
		event.locals.session = null;
		event.locals.user = null;
		return;
	}
	event.locals.session = session;
	event.locals.user = session.user;
}

// Earlier builds set these two on every visitor for a year. Nothing reads them,
// so a browser still holding one gets it expired, with the Path, SameSite and
// Secure it was set with: a deletion that differs in any of them names a
// different cookie and the old one stays.
//
// Two registrations, because neither reaches every response on its own.
// SvelteKit copies `event.cookies` onto resolved responses and onto redirects
// thrown out of `handle` (authorization's 303 to /login), but not onto a
// Response an inner hook returns without resolving, which is how siteGate
// answers. Whatever the returned response still lacks is appended by hand.
const RETIRED_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'strict',
	secure: !dev
} as const;

const expireRetiredCookies: Handle = async ({ event, resolve }) => {
	const held = RETIRED_COOKIE_NAMES.filter((name) => event.cookies.get(name) !== undefined);
	for (const name of held) event.cookies.delete(name, RETIRED_COOKIE_OPTIONS);
	const response = await resolve(event);
	const sent = new Set(
		response.headers.getSetCookie().map((line) => line.slice(0, line.indexOf('=')))
	);
	for (const name of held) {
		if (sent.has(name)) continue;
		response.headers.append(
			'set-cookie',
			`${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict${dev ? '' : '; Secure'}`
		);
	}
	return response;
};

// Loads the session from Redis (keyed by the `SESSION_COOKIE_NAME` cookie) and stashes it
// on `event.locals.session` + `event.locals.user`.
//
// The log calls below pass `sessionId` raw and it leaves as a truncated sha256:
// it is a denied key in `$lib/server/log.ts`, which digests every value under it
// before emit. That string is the whole credential (`getSession` exchanges it for
// the user with no second factor), so the digest is what makes these lines safe
// to ship off the host while still following one visitor across them.
const sessionLoader: Handle = async ({ event, resolve }) => {
	const sessionId = event.cookies.get(SESSION_COOKIE_NAME);
	event.locals.sessionId = sessionId || null;
	event.locals.session = null;
	event.locals.user = null;

	if (sessionId) {
		try {
			const session = await getSession(sessionId);
			if (session) {
				setLocalsSession(event, session);
				log.debug('auth.session.loaded', {
					sessionId,
					subject: session.user.subject,
					expiresAt: session.expiresAt
				});
			} else {
				// Clear the spent cookie, or the browser presents it on every later
				// request and goes on believing it is signed in. A sign-in later in
				// this request still wins: the cookie jar is keyed by name.
				event.cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
				event.locals.sessionId = null;
				log.warn('auth.session.miss', { sessionId, path: event.url.pathname });
			}
		} catch (e) {
			log.error('auth.session.load-error', {
				sessionId,
				path: event.url.pathname,
				error: e as Error
			});
		}
	}

	return resolve(event);
};

// Hook-layer auth gate (defense-in-depth). Any signed-in user is required for
// a group's members/admin surfaces; the *membership* and *group-admin* checks
// need a per-group DB lookup and live in `group/[slug]/+layout.server.ts`.
//
// Matched on `event.route.id`, NOT `event.url.pathname` — the default group's
// clean root URLs (/members, /admin, …) are reroute-mapped onto these routes,
// so the path no longer carries the /group/<slug> prefix but the resolved
// route id always does. Route ids look like `/group/[slug]/members`.
// GROUP_GATED_ROUTE lives in $lib/group-nav so the group layout's
// bfcache-restore reload gates on the exact same set of routes.
const ADMIN_GATED = /^\/group\/\[slug\]\/admin(\/|$)/;

const AUTH_RULES: { match: (id: string) => boolean; level: 'auth' }[] = [
	{ match: (id) => GROUP_GATED_ROUTE.test(id), level: 'auth' }
];

function denyResponse(path: string, status: 401 | 403): Response {
	if (path.startsWith('/api/')) {
		return new Response(JSON.stringify({ error: status === 401 ? 'unauthorized' : 'forbidden' }), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	}
	if (status === 401) {
		throw redirect(303, `/login?callbackUrl=${encodeURIComponent(path)}`);
	}
	return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
}

// With passkeys switched off these endpoints do not exist, for every caller and
// every method. The 404 is answered here rather than by the handlers' own
// guards because `resolve` dispatches on method first: a method the route does
// not export gets a 405 and an `Allow` header naming the ones it does, before
// any handler runs. Returned rather than thrown, so the response still passes
// back through noStoreGated and securityHeaders.
const PASSKEY_ROUTES = new Set(['/(auth)/auth/passkey', '/group/[slug]/members/[id]/passkeys']);

function passkeysOff(method: string): Response {
	return new Response(method === 'HEAD' ? null : 'Not found', {
		status: 404,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}

const authorization: Handle = async ({ event, resolve }) => {
	const routeId = event.route.id ?? '';
	if (!PASSKEYS_ENABLED && PASSKEY_ROUTES.has(routeId)) return passkeysOff(event.request.method);
	const rule = AUTH_RULES.find((r) => r.match(routeId));
	if (rule && !event.locals.user) {
		// The clean URL the visitor actually sees, not the route id.
		const path = event.url.pathname;
		// Admin surfaces: bounce guests to the homepage login modal with the
		// destination in ?next=, so an admin's pasted link lands after sign-in. A
		// signed-in non-admin gets a 403 from the admin pages instead. Members and
		// API keep the plain /login (or JSON) response.
		if (!path.startsWith('/api/') && ADMIN_GATED.test(routeId)) {
			throw redirect(303, `/?login=1&next=${encodeURIComponent(path)}`);
		}
		return denyResponse(path, 401);
	}
	return resolve(event);
};

// Cache-Control for the auth-gated surfaces (members directory/profiles + admin).
// These render member PII, so they must never be cached — by the browser (incl.
// bfcache, so a shared machine can't Back into them after logout), by a CDN, or
// by anything. Matched on route.id (covers the reroute-mapped clean URLs too) via
// GROUP_GATED_ROUTE (= members|admin), and set in the response phase so it
// overrides defaults. The public marketing pages and /avatar keep their own caching.
const noStoreGated: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	if (GROUP_GATED_ROUTE.test(event.route.id ?? '')) {
		response.headers.set('cache-control', 'private, no-store, max-age=0');
	}
	return response;
};

// Static-asset cache control. SvelteKit hashes its own bundle artifacts
// under `_app/immutable/*` and gets a year+immutable header automatically;
// our hand-authored static files (fonts, favicon, robots, imgs) need a
// header set explicitly. Paths are matched on the request URL — we never
// touch dynamic routes.
const STATIC_CACHE_RULES: { match: (p: string) => boolean; value: string }[] = [
	{ match: (p) => p.startsWith('/fonts/'), value: 'public, max-age=2592000' },
	{ match: (p) => p.startsWith('/imgs/'), value: 'public, max-age=86400' },
	{ match: (p) => p === '/favicon.svg' || p === '/favicon.ico', value: 'public, max-age=86400' },
	{ match: (p) => p === '/robots.txt', value: 'public, max-age=3600' }
];

const staticCache: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		return response;
	}
	if (response.status >= 400) return response;
	const path = event.url.pathname;
	for (const rule of STATIC_CACHE_RULES) {
		if (rule.match(path)) {
			response.headers.set('cache-control', rule.value);
			break;
		}
	}
	return response;
};

// A skin is compiled in at build time and read again from SKIN_DIR here. The
// build already refused a bad one, so this fails only when the container was
// started against a different skin than its code was built with, or one this
// code cannot read. Thrown at module load, like the gate config below, so the
// process exits instead of serving pages from a skin nobody validated.
try {
	assertSkinAtBoot(builtSkin);
} catch (e) {
	log.error('boot.skin-refused', { error: e as Error });
	throw e;
}

// Same footing: a mail transport missing its sending domain would come up and
// then fail every sign-in, so the process exits naming the variable instead.
try {
	assertMailConfig();
} catch (e) {
	log.error('boot.mail-refused', { error: e as Error });
	throw e;
}

// The backstop half of the migration contract: `pnpm migrate` runs as a deploy
// step before the container starts, so this finds the schema current and does
// nothing. It stays because `restart: unless-stopped` restarts this container
// on a host reboot, on the memory limit, and on every `docker compose up -d` —
// deleting it would turn one skipped deploy step into a silently stale schema.
// It does not gate: ensureSchema logs and swallows. See docs/deployment.md.
void ensureSchema();

// Retention for the audit trail, on the same "the app does it at boot, no
// scheduler" footing as the schema step above. The first prune fires minutes
// after boot, by which time ensureSchema has created the table. See docs/features.md,
// Audit trail.
startAuditPruner();

// Parsed at module load, so a deployment that meant to be gated and mistyped
// SITE_GATE fails to start instead of coming up open. Cookie options mirror
// SESSION_COOKIE_OPTIONS: apex-scoped in production so one entry covers www and
// the redirect hosts, host-only in dev where there is no apex to share.
const siteGate = createSiteGate(parseGateConfig(env), {
	secure: !dev,
	domain: dev ? undefined : `.${APP_APEX_DOMAIN}`
});

// securityHeaders runs outermost so its response phase runs last and its values
// are the ones on the wire. It is the only unconditional handler here: a
// redirect *thrown* by `authorization` below unwinds past it and reaches the
// client bare, which is why the headers are proven on responses rather than
// assumed (src/lib/server/security-headers.test.ts).
// expireRetiredCookies sits ahead of siteGate so a gated visitor still loses the
// retired cookies; it reads only the request's own cookie header.
// siteGate sits before everything else that remains: it
// returns its responses rather than throwing, so they still collect the header
// baseline on the way out, and short-circuiting above sessionLoader means a
// gated request costs no Redis or Postgres round-trip.
export const handle: Handle = sequence(
	securityHeaders,
	expireRetiredCookies,
	siteGate,
	staticCache,
	noStoreGated,
	sessionLoader,
	authorization
);
