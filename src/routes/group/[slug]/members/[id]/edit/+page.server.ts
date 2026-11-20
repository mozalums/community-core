import { error, fail, redirect } from '@sveltejs/kit';
import { getGroupBySlug, resolveGroupAdmin } from '$lib/server/groups';
import { getMemberById, canEditMember } from '$lib/server/members';
import {
	readEditFields,
	readAffiliations,
	saveMemberProfile,
	formUpdate,
	formEcho,
	choiceEcho
} from '$lib/server/member-edit';
import { hardPurgeMember, MemberWriteError } from '$lib/server/member-write';
import {
	AFFILIATIONS,
	HAS_AFFILIATIONS,
	OTHER_AFFILIATION_KEY,
	PUBLIC_PROFILE_KEY
} from '$lib/server/affiliations';
import { avatarIdFor, deleteAvatar } from '$lib/server/avatars';
import { gravatarHash } from '$lib/server/gravatar';
import { skinCopy } from '$lib/server/skin-copy';
import {
	deleteSession,
	deleteUserSessions,
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_OPTIONS
} from '$lib/server/session-store';
import { actorOf } from '$lib/server/audit-core';
import { groupBase } from '$lib/group-nav';
import { log } from '$lib/server/log';
import type { MemberWithPrivate } from '$lib/server/members';
import type { Group } from '$lib/server/groups';
import type { Actions, PageServerLoad } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the group + member and enforce that the signed-in user may edit it
// (own profile or group admin). Shared by the load and the save action so the
// check is never client-trusted.
async function resolveEditable(
	params: { slug: string; id: string },
	locals: App.Locals
): Promise<{ group: Group; member: MemberWithPrivate; admin: boolean }> {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	if (!UUID.test(params.id)) throw error(404, 'No such member');
	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');

	const user = locals.user ?? null;
	const admin = await resolveGroupAdmin(group, user);
	if (!canEditMember(member, user, admin)) throw error(403, 'You can only edit your own profile');
	return { group, member, admin };
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { group, member } = await resolveEditable(params, locals);
	const welcome = url.searchParams.get('welcome') === '1';
	const avatarId = await avatarIdFor(member.email).catch(() => null);
	// Only the profile's own owner sees the delete button (it signs them out).
	const canDelete = canEditMember(member, locals.user ?? null, false);
	const base = {
		editName: member.name,
		gravatarHash: gravatarHash(member.email),
		avatarId,
		welcome,
		canDelete
	};
	return {
		...base,
		fields: readEditFields(member),
		affiliations: {
			options: AFFILIATIONS.map((a) => ({ key: a.key, label: a.label })),
			// Which of these controls the skin has a field for.
			asked: HAS_AFFILIATIONS,
			hasOther: OTHER_AFFILIATION_KEY !== undefined,
			hasPublicProfile: PUBLIC_PROFILE_KEY !== undefined,
			// The skin's copy/affiliations-help.md, under the card's heading.
			helpHtml: skinCopy('affiliations-help'),
			...readAffiliations(member)
		}
	};
};

export const actions: Actions = {
	save: async ({ request, params, locals, url }) => {
		const { group, member, admin } = await resolveEditable(params, locals);
		const u = formUpdate(await request.formData());
		const echo = () => ({ values: formEcho(u), choices: choiceEcho(u) });

		try {
			const written = await saveMemberProfile(group, member, u, actorOf(locals.user), { admin });
			log.info('member-edit.saved', { groupId: group.id, memberId: member.id, fields: written });
		} catch (e) {
			if (e instanceof MemberWriteError) {
				return fail(e.status, { error: `Could not save — ${e.message}`, ...echo() });
			}
			log.error('member-edit.save-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: `Could not save — ${(e as Error).message}`, ...echo() });
		}

		throw redirect(303, `${groupBase(url.pathname, params.slug)}/members/${member.id}`);
	},

	// Permanently delete this member, revoke their sessions, and — when it's the
	// owner deleting their own profile — sign them out.
	//
	// The member row is the only store, so its DELETE is the whole deletion and
	// commits with its audit row; a failure there is the action's failure, with
	// sessions untouched and the profile intact for a retry. While a sheet row
	// also existed, the order (Postgres first, then the sheet row, then the
	// rest) decided which store a half-finished delete left behind; with the
	// sheet step gone that question no longer arises. Avatar and sessions follow
	// as best-effort cleanup that cannot un-delete anyone.
	delete: async ({ params, locals, cookies, url }) => {
		const { group, member } = await resolveEditable(params, locals);
		const isSelf = canEditMember(member, locals.user ?? null, false);
		const subjectKey = `email:${member.email.toLowerCase()}`;

		try {
			await hardPurgeMember(group, member.id, actorOf(locals.user), subjectKey);
		} catch (e) {
			log.error('member-delete.db-failed', { groupId: group.id, error: e as Error });
			return fail(500, {
				deleteError: 'Could not delete the profile. Nothing was removed; try again.'
			});
		}

		await deleteAvatar(member.email).catch(() => {});

		// Revoke the member's sessions (by subject) so their access is cut.
		await deleteUserSessions(subjectKey).catch(() => {});
		if (member.identSubject && member.identSubject !== subjectKey) {
			await deleteUserSessions(member.identSubject).catch(() => {});
		}
		log.info('member-delete.done', { groupId: group.id, memberId: member.id, isSelf });

		// Own profile → clear the current session + cookie and land signed-out on
		// the group's landing. (An admin removing someone else stays signed in.)
		if (isSelf) {
			const sid = cookies.get(SESSION_COOKIE_NAME);
			if (sid) await deleteSession(sid).catch(() => {});
			cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
			throw redirect(303, groupBase(url.pathname, params.slug) || '/');
		}
		throw redirect(303, `${groupBase(url.pathname, params.slug)}/members`);
	}
};
