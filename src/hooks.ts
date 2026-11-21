import type { Reroute } from '@sveltejs/kit';
import { DEFAULT_GROUP_SLUG } from '$lib/group-nav';

// Single-tenant-for-now routing. The default group is served at clean root
// URLs; this universal reroute maps those paths onto the existing
// /group/[slug]/* route tree without changing the browser URL (so loaders see
// the clean `url` but get `params.slug` from the matched group route). Runs on
// both server (SSR) and client (in-app navigation). When multiple groups land,
// delete this hook and restore a real homepage at src/routes/+page.svelte.
//
// `/login`, `/logout`, `/auth/*`, `/api/*`, `/healthz` and static assets are
// intentionally NOT mapped — they pass through untouched. `/login` and
// `/auth/magic` in particular are the shared sign-in entry points.
const PREFIX = `/group/${DEFAULT_GROUP_SLUG}`;

const CLEAN_TO_GROUP: Record<string, string> = {
	'/': PREFIX,
	'/home': `${PREFIX}/home`,
	'/members': `${PREFIX}/members`,
	'/admin': `${PREFIX}/admin`,
	'/admin/landing': `${PREFIX}/admin/landing`,
	'/request': `${PREFIX}/request`,
	'/join': `${PREFIX}/join`,
	'/manifesto': `${PREFIX}/manifesto`,
	'/code-of-conduct': `${PREFIX}/code-of-conduct`,
	'/privacy': `${PREFIX}/privacy`
};

export const reroute: Reroute = ({ url }) => {
	const exact = CLEAN_TO_GROUP[url.pathname];
	if (exact) return exact;
	// Clean sub-paths under the directory, admin or an unfinished removal (e.g.
	// /members/<id>, /admin/requests) map onto the group route tree too.
	if (
		url.pathname.startsWith('/members/') ||
		url.pathname.startsWith('/admin/') ||
		url.pathname.startsWith('/removal/')
	) {
		return `${PREFIX}${url.pathname}`;
	}
};
