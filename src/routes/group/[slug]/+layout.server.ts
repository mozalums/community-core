import { error, redirect } from '@sveltejs/kit';
import { getGroupBySlug, resolveGroupAdmin } from '$lib/server/groups';
import { resolveMember, countMembers } from '$lib/server/members';
import { avatarIdFor } from '$lib/server/avatars';
import { gravatarHash } from '$lib/server/gravatar';
import { groupBase } from '$lib/group-nav';
import { hasSkinCopy, skinCopy } from '$lib/server/skin-copy';
import type { LayoutServerLoad } from './$types';

// Core membership gate. Resolves, for the current group:
//   group        — 404 if the slug doesn't exist
//   member       — the active member matching the signed-in identity, or null
//   isGroupAdmin — group_admin row OR global superadmin (ADMIN_SUBJECTS)
// The whole /group/[slug]/* subtree reads these; members/admin sub-layouts
// enforce access on top of them.
export const load: LayoutServerLoad = async ({ params, locals, url }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');

	const user = locals.user ?? null;
	const { member, firstLogin } = user
		? await resolveMember(group.id, user.email, user.subject)
		: { member: null, firstLogin: false };

	// First login: the moment a brand-new member's identity binds to their row,
	// send them to complete their profile (edit mode, ?welcome=1 shows the
	// "Please complete your profile" header). Fires once — the bind only happens once.
	if (firstLogin && member) {
		const editPath = `${groupBase(url.pathname, params.slug)}/members/${member.id}/edit`;
		if (url.pathname !== editPath) throw redirect(303, `${editPath}?welcome=1`);
	}

	// Admin from ADMIN_SUBJECTS or a group_admin row, by subject.
	const groupAdmin = await resolveGroupAdmin(group, user);

	// Directory size for the sidebar (shown on every signed-in page). Only needed
	// once someone's in; guests see the landing, not the sidebar.
	const memberCount = user ? await countMembers(group.id).catch(() => 0) : 0;
	// The sidebar renders the signed-in user's own photo, and its URL id is not
	// derivable from their address (src/routes/avatar/[id]/+server.ts), so the
	// server has to hand it over. Dash-access users have an avatar too; key on
	// the session address, not on the member row.
	const userAvatarId = user ? await avatarIdFor(user.email).catch(() => null) : null;

	return {
		// Raw landing_md is intentionally NOT exposed here — the public page
		// renders it server-side (group/+page.server.ts) and ships only HTML.
		group: { slug: group.slug, name: group.name },
		member: member
			? { id: member.id, name: member.name, email: member.email, city: member.city }
			: null,
		isGroupAdmin: groupAdmin,
		// Short form only: enough to match a running deployment against a commit.
		// Blank rather than 'unknown' so the two places that show it omit the line
		// instead of printing a word that reads to a member like a fault.
		//
		// `process.env` rather than `$env/dynamic/private`, on the terms log.ts
		// reads LOG_LEVEL: the alias does not resolve under the test runner, and
		// importing it here fails this file's own tests. One adapter ships from
		// this tree, and it populates process.env.
		buildSha: (process.env.LOREM_BUILD_SHA || '')
			.trim()
			.slice(0, 7)
			.replace(/^unknown$/, ''),
		// The core release beside the commit. A site that pins core stamps its
		// own commit as the build, so the commit alone no longer names core.
		coreTag: (process.env.CORE_TAG || '').trim(),
		memberCount,
		// The skin's documents decide their routes and every link to them. The
		// sidebar text is for the signed-in shell, so a guest's page omits it.
		documents: {
			manifesto: hasSkinCopy('manifesto'),
			codeOfConduct: hasSkinCopy('code-of-conduct')
		},
		sidebarHtml: user ? skinCopy('sidebar') : '',
		userAvatarId,
		// The sidebar's Gravatar fallback. Hashed here rather than in the component
		// so no page hands an address to <Gravatar> — see src/lib/gravatar.ts.
		userGravatarHash: gravatarHash(user?.email),
		user
	};
};
