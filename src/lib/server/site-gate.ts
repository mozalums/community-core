// A shared passphrase in front of the entire site, for the period where the
// deployment is being worked on and should not be publicly browsable.
//
// This is not authentication. It proves the visitor was told a password by
// somebody, nothing about who they are, and it sits in front of the real
// sign-in rather than replacing any part of it. Everything downstream —
// sessions, membership, group admin — is unchanged and still enforced.
//
// Config arrives as an argument rather than being read here, for the reason
// rate-limit.ts records about `$env/dynamic/private`: it only resolves under
// Vite, and a module that imports it cannot be unit tested. hooks.server.ts
// reads the environment and hands the parsed result in.
//
// WHAT THIS DOES NOT COVER. adapter-node builds its request chain as
// `sequence([serve(client), serve_prerendered(), ssr])`, so files under
// `build/client` are answered by sirv before `handle` runs. Every rendered
// page, form action and endpoint goes through the gate; individually-named
// static files do not. Measured against a production build with the gate on:
//
//   /                            gate page      /_app/immutable/entry/app.<hash>.js   200
//   /imgs/                       gate page      /_app/version.json                    200
//   /_app/immutable/             404            /favicon.svg, /robots.txt             200
//
// sirv does not list directories — `/imgs/` and `/_app/immutable/` fall through
// to the gated handler — so nothing here is enumerable, and the bundle's names
// are content hashes that appear only in a page this gate refuses to render.
// The reachable set is branding assets and a build timestamp, and it holds no
// member data. Closing it means moving the gate ahead of sirv, which needs a
// wrapper entrypoint in place of `node build/index.js`.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Handle } from '@sveltejs/kit';

export const GATE_COOKIE_NAME = 'community_gate';

// The only path that skips the gate, matched exactly so there is no prefix for
// a crafted path to sit under.
//
//   /healthz      The healthcheck compiled into the image (Dockerfile) curls it
//                 and marks the container unhealthy on a non-2xx. Returns no
//                 data about the site.
//
// Nothing else is exempt. /auth/magic/send in particular stays gated: it sends
// mail to an address the caller names, and a closed site is exactly when it
// should not be reachable.
const EXEMPT_PATHS = ['/healthz'];

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 30;

// Domain separation, so the cookie key is not the passphrase itself and a
// stolen cookie cannot be worked backwards into the value people type.
const KEY_CONTEXT = 'lorem-site-gate-v1';

export type GateConfig = { mode: 'off' } | { mode: 'password'; password: string; maxAge: number };

/**
 * Reads SITE_GATE / SITE_GATE_PASSWORD / SITE_GATE_MAX_AGE.
 *
 * Throws rather than falling back, matching `mailTransport()`: a deployment
 * that meant to be gated and typed the variable wrong should fail to start,
 * not come up serving the site to everyone.
 */
export function parseGateConfig(env: Record<string, string | undefined>): GateConfig {
	const raw = (env.SITE_GATE || 'off').trim().toLowerCase();
	if (raw === 'off') return { mode: 'off' };
	if (raw !== 'password') {
		throw new Error(`SITE_GATE must be 'off' or 'password', got '${raw}'`);
	}

	const password = (env.SITE_GATE_PASSWORD || '').trim();
	if (!password) {
		throw new Error('SITE_GATE=password requires SITE_GATE_PASSWORD to be set');
	}

	const rawAge = (env.SITE_GATE_MAX_AGE || '').trim();
	let maxAge = DEFAULT_MAX_AGE;
	if (rawAge) {
		maxAge = Number(rawAge);
		if (!Number.isInteger(maxAge) || maxAge <= 0) {
			throw new Error(
				`SITE_GATE_MAX_AGE must be a positive whole number of seconds, got '${rawAge}'`
			);
		}
	}

	return { mode: 'password', password, maxAge };
}

function keyFor(password: string): Buffer {
	return createHmac('sha256', password).update(KEY_CONTEXT).digest();
}

function macFor(password: string, expiry: string): string {
	return createHmac('sha256', keyFor(password)).update(expiry).digest('base64url');
}

// Digest both sides first so the buffers are always 32 bytes. timingSafeEqual
// throws on a length mismatch, which would turn "your guess was the wrong
// length" into an observably different response.
function constantTimeEqual(a: string, b: string): boolean {
	return timingSafeEqual(
		createHash('sha256').update(a).digest(),
		createHash('sha256').update(b).digest()
	);
}

export function passwordMatches(submitted: string, configured: string): boolean {
	return constantTimeEqual(submitted, configured);
}

/** `<expiry>.<mac>` — the expiry is signed, so it cannot be extended by hand. */
export function issueCookieValue(password: string, maxAge: number, now = Date.now()): string {
	const expiry = String(Math.floor(now / 1000) + maxAge);
	return `${expiry}.${macFor(password, expiry)}`;
}

// Keyed on the passphrase, so changing SITE_GATE_PASSWORD invalidates every
// cookie already handed out. That is the revocation mechanism: there is no
// per-visitor record to delete.
export function cookieValid(
	value: string | undefined,
	password: string,
	now = Date.now()
): boolean {
	if (!value) return false;
	const dot = value.indexOf('.');
	if (dot <= 0) return false;

	const expiry = value.slice(0, dot);
	if (!/^\d+$/.test(expiry)) return false;
	if (Number(expiry) <= Math.floor(now / 1000)) return false;

	return constantTimeEqual(value.slice(dot + 1), macFor(password, expiry));
}

function gatePage(failed: boolean): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Not yet</title>
<style>
:root { color-scheme: light dark; --bg: #f5f5f4; --fg: #1c1917; --muted: #78716c; --line: #d6d3d1; --err: #be123c; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0a0a0a; --fg: #f5f5f4; --muted: #a8a29e; --line: #292524; --err: #fb7185; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: var(--bg); color: var(--fg); padding: 1.5rem;
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: 100%; max-width: 20rem; text-align: center; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { color: var(--muted); margin: 0 0 1.5rem; font-size: .9rem; }
input, button { width: 100%; font: inherit; border-radius: .5rem; padding: .625rem .75rem; }
input { border: 1px solid var(--line); background: transparent; color: inherit; margin-bottom: .75rem; }
input:focus { outline: 2px solid var(--fg); outline-offset: -1px; }
button { border: 0; background: var(--fg); color: var(--bg); font-weight: 600; cursor: pointer; }
.err { color: var(--err); margin: 0 0 1rem; font-size: .85rem; }
</style>
</head>
<body>
<main>
<h1>This site is still being built</h1>
<p>Enter the password you were given to take a look around.</p>
${failed ? '<p class="err">That password is not right.</p>' : ''}
<form method="POST">
<input type="password" name="gate-password" aria-label="Password" autocomplete="current-password" autofocus required>
<button type="submit">Enter</button>
</form>
</main>
</body>
</html>`;
}

// `kit.csp` in svelte.config.js only reaches pages SvelteKit renders, and this
// one is built here. It is not a copy of that policy: the page loads nothing and
// runs no script, so it gets a narrower one that allows its inline <style> and
// its form post, and nothing else. The page policy's nonce and analytics hosts
// have no meaning here.
const GATE_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'"
].join('; ');

function pageResponse(failed: boolean): Response {
	return new Response(gatePage(failed), {
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-security-policy': GATE_CSP,
			'cache-control': 'no-store',
			'x-robots-tag': 'noindex, nofollow'
		}
	});
}

/**
 * Bounds the cost of guessing. Reuses the counters everything else uses, and
 * deliberately does not gate on them being reachable: a Redis outage takes the
 * cap away, not the check. The constant-time compare is the control.
 */
async function overAttemptLimit(event: Parameters<Handle>[0]['event']): Promise<boolean> {
	try {
		const [{ clientAddress }, { rateLimitKey, rateLimited }] = await Promise.all([
			import('$lib/server/client-address'),
			import('$lib/server/rate-limit')
		]);
		const ip = clientAddress(event as never);
		return await rateLimited(rateLimitKey('gate-rl:ip', ip), 10, 900);
	} catch {
		return false;
	}
}

export function createSiteGate(
	config: GateConfig,
	opts: { secure: boolean; domain?: string }
): Handle {
	if (config.mode === 'off') {
		return ({ event, resolve }) => resolve(event);
	}

	const { password, maxAge } = config;
	const cookieFlags = [
		'Path=/',
		`Max-Age=${maxAge}`,
		'HttpOnly',
		'SameSite=Lax',
		opts.secure ? 'Secure' : null,
		opts.domain ? `Domain=${opts.domain}` : null
	]
		.filter(Boolean)
		.join('; ');

	return async ({ event, resolve }) => {
		if (EXEMPT_PATHS.includes(event.url.pathname)) return resolve(event);

		if (cookieValid(event.cookies.get(GATE_COOKIE_NAME), password)) {
			const response = await resolve(event);
			response.headers.set('x-robots-tag', 'noindex, nofollow');
			return response;
		}

		if (event.request.method === 'POST') {
			// adapter-node's ORIGIN check covers form actions, not a response built
			// here, so the gate has to reject a cross-site POST itself or it accepts
			// one that plants a valid cookie. Only enforced when the header is
			// present: every browser sends it on POST, and a request without one did
			// not come from the browser a CSRF needs.
			const origin = event.request.headers.get('origin');
			if (origin && origin !== event.url.origin) {
				return new Response('forbidden', {
					status: 403,
					headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex, nofollow' }
				});
			}

			const form = await event.request.formData().catch(() => null);
			const submitted = form?.get('gate-password');
			if (typeof submitted === 'string') {
				if (await overAttemptLimit(event)) {
					return new Response('too many attempts', {
						status: 429,
						headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex, nofollow' }
					});
				}
				if (passwordMatches(submitted, password)) {
					return new Response(null, {
						status: 303,
						headers: {
							location: `${event.url.pathname}${event.url.search}`,
							'set-cookie': `${GATE_COOKIE_NAME}=${issueCookieValue(password, maxAge)}; ${cookieFlags}`,
							'cache-control': 'no-store',
							'x-robots-tag': 'noindex, nofollow'
						}
					});
				}
				return pageResponse(true);
			}
		}

		return pageResponse(false);
	};
}
