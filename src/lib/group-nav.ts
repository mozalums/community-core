// Single-tenant-for-now navigation helpers.
//
// The deployment serves the skin's default group at clean root URLs
// (/, /members, /admin, …) while its canonical home stays /group/<slug>/*.
// A universal `reroute` hook (src/hooks.ts) maps the clean paths onto the
// existing /group/[slug]/* route tree WITHOUT changing the browser URL, so
// there's exactly one set of routes/loaders. The helpers below let every
// link and server redirect stay consistent with how the page was reached:
// clean (no prefix) for the default group, /group/<slug> for the canonical
// or non-default paths.
//
// Universal module — safe to import on client and server. No $env / $app /
// server-only imports.

import { site } from '$skin/skin.yaml';

export const DEFAULT_GROUP_SLUG = site.default_group;

// Resolved route ids of the auth-gated member/admin surfaces (route ids, not
// pathnames — the reroute hook maps clean root URLs onto /group/[slug]/*, so
// the id always carries the prefix). Shared by the server hooks (auth gate +
// no-store headers) and the group layout (bfcache-restore reload) so the two
// can never drift.
export const GROUP_GATED_ROUTE = /^\/group\/\[slug\]\/(members|admin)(\/|$)/;

// Link/redirect base for the current request. '' when we arrived via a clean
// root URL (default group), '/group/<slug>' when via the canonical prefixed
// URL or for a non-default group. Keyed off the *incoming* pathname so links
// match the URL style the visitor is actually on.
export function groupBase(pathname: string, slug: string): string {
	const prefix = `/group/${slug}`;
	return pathname === prefix || pathname.startsWith(`${prefix}/`) ? prefix : '';
}

// The group's landing page href ('/' for a clean default-group URL).
export function groupHome(pathname: string, slug: string): string {
	return groupBase(pathname, slug) || '/';
}

// Where the "Sign in" affordance should point: the /login page (magic-link email
// form), carrying the post-login destination as callbackUrl. On the landing page
// this href is the no-JS fallback — the modal intercepts the click when JS is on.
export function signInHref(pathname: string, slug: string): string {
	const base = groupBase(pathname, slug);
	const dest = base ? `${base}/members` : '/members';
	return `/login?callbackUrl=${encodeURIComponent(dest)}`;
}
