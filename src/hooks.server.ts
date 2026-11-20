import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { sequence } from '@sveltejs/kit/hooks';
import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit';
import { APP_APEX_DOMAIN } from '$lib/site';
import { GROUP_GATED_ROUTE } from '$lib/group-nav';
import { isoWeekCohort } from '$lib/server/iso-week';
import { log } from '$lib/server/log';
import { assertSkinAtBoot } from '$lib/skin/load';
import builtSkin from '$skin/skin.yaml?raw';
import { assertMailConfig } from '$lib/server/mail';
import { ensureSchema } from '$lib/server/schema';
import { startAuditPruner } from '$lib/server/audit';
import { securityHeaders } from '$lib/server/security-headers';
import {
	COHORT_COOKIE_NAME,
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS,
	UTM_COOKIE_NAME,
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

const MARKETING_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

// Capture first-touch UTM params and stamp each visitor with an ISO-week
// cohort, both on year-long cookies. Exposes `event.locals.marketing` for
// downstream code (signup, analytics, server-side logging).
const marketing: Handle = async ({ event, resolve }) => {
	const setCookies: string[] = [];
	const cookieFlags = `Path=/; Max-Age=${MARKETING_COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict${dev ? '' : '; Secure'}`;

	const utm: Record<string, string> = {};
	for (const [key, value] of event.url.searchParams.entries()) {
		if (key.startsWith('utm_')) utm[key] = value;
	}
	if (Object.keys(utm).length > 0) {
		setCookies.push(`${UTM_COOKIE_NAME}=${encodeURIComponent(JSON.stringify(utm))}; ${cookieFlags}`);
	} else {
		const existing = event.cookies.get(UTM_COOKIE_NAME);
		if (existing) {
			try {
				Object.assign(utm, JSON.parse(decodeURIComponent(existing)));
			} catch {
				// malformed cookie — ignore; locals.marketing.utm stays empty
			}
		}
	}

	let cohort = event.cookies.get(COHORT_COOKIE_NAME);
	if (!cohort) {
		cohort = isoWeekCohort();
		setCookies.push(`${COHORT_COOKIE_NAME}=${cohort}; ${cookieFlags}`);
	}

	event.locals.marketing = { cohort, utm };

	const response = await resolve(event);
	for (const c of setCookies) response.headers.append('set-cookie', c);
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

const authorization: Handle = async ({ event, resolve }) => {
	const routeId = event.route.id ?? '';
	const rule = AUTH_RULES.find((r) => r.match(routeId));
	if (rule && !event.locals.user) {
		// The clean URL the visitor actually sees, not the route id.
		const path = event.url.pathname;
		// Admin surfaces: bounce guests to the homepage login modal (destination
		// preserved via ?next=) so they sign in as an admin — matching the
		// not-an-admin bounce in group/[slug]/admin/+layout.server.ts. Members and
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
// siteGate sits directly inside securityHeaders and before everything else: it
// returns its responses rather than throwing, so they still collect the header
// baseline on the way out, and short-circuiting above sessionLoader means a
// gated request costs no Redis or Postgres round-trip.
export const handle: Handle = sequence(
	securityHeaders,
	siteGate,
	staticCache,
	noStoreGated,
	marketing,
	sessionLoader,
	authorization
);
