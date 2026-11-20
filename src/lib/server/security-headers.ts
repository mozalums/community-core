// The security-header baseline for every response this process emits — HTML
// pages, image bytes, JSON, all of it.
//
// Who sets what, because a header set in two places with two values is a
// debugging session nobody enjoys:
//
//   app, here            X-Content-Type-Options, X-Frame-Options,
//                        Referrer-Policy — version-controlled, true under
//                        `pnpm dev`, and reaching the endpoints (/avatar,
//                        /api/*) that a page CSP never touches.
//   app, svelte.config   Content-Security-Policy, for rendered pages only.
//                        `kit.csp` knows the nonce for the inline scripts
//                        SvelteKit generated; nothing here sets a second copy.
//   app, site-gate       Content-Security-Policy for the gate page, which
//                        SvelteKit does not render and kit.csp never reaches.
//   nginx                Strict-Transport-Security, and nothing else. TLS
//                        terminates at the proxy, and the responses it
//                        generates itself — the :80 redirect, a 413 from
//                        client_max_body_size, a 502 when the container is
//                        down — never reach this process at all. See
//                        deploy/nginx/example.conf.
//
// This module is separate from hooks.server.ts so a test can drive the handler
// without importing `$app/environment`, which only resolves under Vite.

import type { Handle } from '@sveltejs/kit';

// `nosniff` earns its place on /avatar/<id>, which serves stored bytes under a
// stored content_type. The upload re-encodes every photo and stores the type
// the decoder found (avatar-image.ts), which is the real control; this is the
// belt to its braces, and still the only one on bytes fetched from Gravatar.
//
// X-Frame-Options is the frame-ancestors control for everything the page CSP
// never sees — image bytes and JSON are not rendered pages, so `kit.csp`'s
// `frame-ancestors 'none'` is absent from them. The two say the same thing on
// the surfaces where both apply.
export const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY'
};

// Stated rather than inherited: it is the modern browser default, but the
// default is a browser's choice and this is a security control. Same-origin
// navigations keep the full referrer, cross-origin ones send the bare origin,
// and a downgrade to http sends nothing.
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

// /auth/* tightens to strict-origin because a magic-link token rides in the
// query string (magic-link.ts). A successful click redirects away, but the page
// that renders when the token is missing, used or expired keeps `?token=…` in
// the address bar, and any outbound link clicked from there would hand a third
// party's referrer log a live sign-in URL. strict-origin sends the bare origin
// and never a path, to any destination, so the token cannot ride out.
//
// It is not `no-referrer`, which closes the same leak and also breaks sign-in.
// Fetch's "append a request Origin header" step reads the referrer policy for
// any request that is not GET or HEAD, and under `no-referrer` it sends
// `Origin: null`. SvelteKit's csrf.checkOrigin compares that against
// `event.url.origin` and rejects the POST with "Cross-site POST form
// submissions are forbidden", so the confirm button on this very page cannot
// work. Every policy in the strict-origin family is exempt from that rule
// except on an https-to-http downgrade, which TLS termination rules out here.
export const AUTH_REFERRER_POLICY = 'strict-origin';

export function referrerPolicyFor(pathname: string): string {
	return pathname === '/auth' || pathname.startsWith('/auth/')
		? AUTH_REFERRER_POLICY
		: REFERRER_POLICY;
}

// Response phase, so the values land after the route handler has run and
// whatever it set (cache-control on the gated surfaces, ETag on /avatar) is
// left alone.
export const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		response.headers.set(name, value);
	}
	response.headers.set('referrer-policy', referrerPolicyFor(event.url.pathname));
	return response;
};
