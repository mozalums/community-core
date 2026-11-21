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

// The group base a same-origin path sits under, for pages outside the group
// tree (/login) that link back into it. '' for a clean default-group path.
export function baseOfPath(path: string): string {
	const m = /^\/group\/([^/?#]+)/.exec(path);
	return m ? `/group/${m[1]}` : '';
}

// Where the "Sign in" affordance should point: the /login page (magic-link email
// form), carrying the post-login destination as callbackUrl. On the landing page
// this href is the no-JS fallback — the modal intercepts the click when JS is on.
export function signInHref(pathname: string, slug: string): string {
	const base = groupBase(pathname, slug);
	const dest = base ? `${base}/members` : '/members';
	return `/login?callbackUrl=${encodeURIComponent(dest)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whether a profile URL's `[id]` segment is a member id rather than a username.
export const isUuid = (s: string): boolean => UUID.test(s);

// The `[id]` segment of a member's canonical profile URL: the username they
// chose, else their uuid. Every link to a profile, and to the edit, star and
// avatar routes under it, is built from this.
export function memberRef(m: { id: string; username?: string | null }): string {
	return m.username || m.id;
}

// SvelteKit's pathname decoding (`decode_pathname`): decodeURI on everything
// but `%25`. It leaves `%2F` encoded, so splitting the raw and the decoded
// path on `/` yields the same segment positions.
function routerDecode(segment: string): string | null {
	try {
		return segment.split('%25').map(decodeURI).join('%25');
	} catch {
		return null;
	}
}

function paramDecode(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

// Where a profile request should be sent when its decoded `[id]` segment is
// not the canonical one (a uuid for a member with a username, a retired name, a
// name in another case), keeping the clean or /group/<slug> base, the sub-route
// and the query exactly as sent. Null when the request is already canonical.
//
// The segment is replaced by its position in the route tree, never found by
// searching for its text: a group slug or a sub-route may read `members` too,
// and SvelteKit decodes params but leaves the URL as sent, so `%6Fld-name`
// would not contain the text `old-name` at all. The position comes from the
// same decoding the router applied: the reroute hook sees the raw path and
// maps only a literal `/members/…` onto the group tree, while the router
// matches the decoded path, so `/%67roup/<slug>/members/<id>` is the prefixed
// route and must not be mistaken for the clean one. A position whose segment
// does not decode to the matched param is not the profile segment, and
// rewriting it would send the request to another group, so that yields null.
export function canonicalMemberUrl(url: URL, segment: string, ref: string): string | null {
	if (segment === ref) return null;
	const parts = url.pathname.split('/');
	const at = parts[1] !== undefined && routerDecode(parts[1]) === 'group' ? 4 : 2;
	if (parts.length <= at || paramDecode(parts[at]) !== segment) return null;
	parts[at] = encodeURIComponent(ref);
	return `${parts.join('/')}${url.search}`;
}
