// Authorization for actions, endpoints, and the page loads under a gated subtree.
//
// SvelteKit runs a route's ancestor layout `load` functions only when it renders
// a page. Dispatching a form action or a `+server.ts` handler jumps straight to
// the handler body and re-runs `load` afterwards, so a gate written into a
// `+layout.server.ts` is never consulted before the mutation commits. Every
// action and endpoint under a gated subtree has to re-resolve its own permission
// here, before the first side effect — the hook-layer rule in hooks.server.ts
// only proves the caller is signed in, and `mintEmailSession` hands a session to
// any address that can receive mail.

import { error } from '@sveltejs/kit';
import { getGroupBySlug, resolveGroupAdmin, type Group } from '$lib/server/groups';
import { resolveMember, type Member } from '$lib/server/members';
import type { SessionUser } from '$lib/server/session-store';

// The gate in group/[slug]/admin/+layout.server.ts, in a form actions and page
// loads can use. A page load needs it as much as an action: a leaf-only
// `__data.json` request runs the page load without its ancestor layouts.
//
// The grant check runs against the group's identity alone. Unpublished landing
// text is admin data too, so the full row is read only once the caller holds
// the grant, and only if the slug still names the group that was checked.
export async function requireGroupAdmin(
	params: { slug: string },
	locals: App.Locals
): Promise<Group> {
	const identity = await getGroupBySlug(params.slug, { landing: false });
	if (!identity) throw error(404, 'No such community');
	if (!(await resolveGroupAdmin(identity, locals.user))) {
		throw error(403, 'Group admins only');
	}
	const group = await getGroupBySlug(params.slug);
	if (!group || group.id !== identity.id) throw error(404, 'No such community');
	return group;
}

// The gate in group/[slug]/members/+layout.server.ts: a synced member or a
// group admin. Short-circuits in that order, cheapest lookup first.
export async function requireDirectoryAccess(
	params: { slug: string },
	locals: App.Locals
): Promise<{ group: Group; user: SessionUser; member: Member | null }> {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	const user = locals.user;
	if (!user) throw error(401, 'Sign in required');

	const { member } = await resolveMember(group.id, user.email, user.subject);
	if (member) return { group, user, member };
	if (await resolveGroupAdmin(group, user)) return { group, user, member: null };

	throw error(403, 'Directory members only');
}

