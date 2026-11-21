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
import { MemberWriteError } from '$lib/server/member-write';
import { pendingRemovalFor, removeMember } from '$lib/server/member-removal';
import {
	AFFILIATIONS,
	HAS_AFFILIATIONS,
	OTHER_AFFILIATION_KEY,
	PUBLIC_PROFILE_KEY
} from '$lib/server/affiliations';
import { avatarIdFor } from '$lib/server/avatars';
import { skinCopy } from '$lib/server/skin-copy';
import { PASSKEYS_ENABLED, reauthState, sessionIsFresh } from '$lib/server/passkeys';
import { readIdentityIn, type Client } from '$lib/server/email-change-core';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from '$lib/server/session-store';
import { actorOf } from '$lib/server/audit-core';
import { canonicalMemberUrl, groupBase, isUuid, memberRef } from '$lib/group-nav';
import { query, withTransaction } from '$lib/server/postgres';
import {
	USERNAME_CONTROL,
	checkUsername,
	releaseUsernameIn,
	retiredUsernames
} from '$lib/server/usernames';
import { log } from '$lib/server/log';
import type { MemberWithPrivate } from '$lib/server/members';
import type { Group } from '$lib/server/groups';
import type { Actions, PageServerLoad } from './$types';

// Resolve the group + member and enforce that the signed-in user may edit it
// (own profile or group admin). Shared by the load and the save action so the
// check is never client-trusted.
// A row whose deletion committed but whose cleanup did not finish sends a
// requester who may finish it to the removal page, which is how a plain form
// POST of a failed delete reaches recovery when the requester is an admin.
async function resolveEditable(
	params: { slug: string; id: string },
	locals: App.Locals,
	url: URL
): Promise<{ group: Group; member: MemberWithPrivate; admin: boolean }> {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	const member = await getMemberById(group.id, params.id);
	if (!member) {
		if (await pendingRemovalFor(group, params.id, locals.user ?? null)) {
			throw redirect(303, `${groupBase(url.pathname, params.slug)}/removal/${params.id}`);
		}
		throw error(404, 'No such member');
	}

	const user = locals.user ?? null;
	const admin = await resolveGroupAdmin(group, user);
	// A username can be guessed where a uuid cannot. Reached by name, a profile
	// the caller may not edit answers the same 404 as a name nobody holds, so these
	// routes cannot tell a signed-in stranger which names belong to members.
	if (!canEditMember(member, user, admin)) {
		if (!isUuid(params.id)) throw error(404, 'No such member');
		throw error(403, 'You can only edit your own profile');
	}
	return { group, member, admin };
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	const { group, member, admin } = await resolveEditable(params, locals, url);
	const ref = memberRef(member);
	const canonical = canonicalMemberUrl(url, params.id, ref);
	if (canonical) throw redirect(308, canonical);
	const welcome = url.searchParams.get('welcome') === '1';
	const avatarId = await avatarIdFor(member.email).catch(() => null);
	// Only the profile's own owner sees the delete button (it signs them out).
	const canDelete = canEditMember(member, locals.user ?? null, false);
	const base = {
		editName: member.name,
		id: member.id,
		ref,
		// The member chooses their own username; an admin editing them sees the
		// names they gave up instead, to release one.
		username: canDelete ? { value: member.username ?? '', control: USERNAME_CONTROL } : null,
		retiredUsernames: admin ? await retiredUsernames(group.id, member.id) : null,
		avatarId,
		welcome,
		canDelete,
		// The owner's own credentials only, never an admin editing someone else.
		// The list itself comes from the passkeys endpoint.
		passkeys:
			PASSKEYS_ENABLED && canDelete
				? { fresh: sessionIsFresh(locals.session), email: member.email }
				: null,
		// Owner only, like the passkeys: whoever sets the address owns the account.
		emailChange: canDelete
			? {
					reauth: reauthState(
						locals.session,
						PASSKEYS_ENABLED &&
							((await readIdentityIn({ query } as unknown as Client, member.id))?.passkeys ?? 0) > 0
					),
					email: member.email
				}
			: null
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
		const { group, member, admin } = await resolveEditable(params, locals, url);
		const form = await request.formData();
		// Absent is not empty: a form without the control (an admin's) leaves the
		// username alone, and an empty one clears it.
		const username = form.has(USERNAME_CONTROL) ? String(form.get(USERNAME_CONTROL)) : undefined;
		form.delete(USERNAME_CONTROL);
		const u = formUpdate(form);
		const echo = () => ({
			values: formEcho(u),
			choices: choiceEcho(u),
			...(username === undefined ? {} : { username })
		});
		if (username !== undefined && !canEditMember(member, locals.user ?? null, false)) {
			return fail(403, {
				error: 'Could not save — only the member can choose their username',
				...echo()
			});
		}

		try {
			const written = await saveMemberProfile(
				group,
				member,
				u,
				actorOf(locals.user),
				{ admin },
				username
			);
			log.info('member-edit.saved', { groupId: group.id, memberId: member.id, fields: written });
		} catch (e) {
			if (e instanceof MemberWriteError) {
				return fail(e.status, {
					error: `Could not save — ${e.message}`,
					...(e.field ? { fieldError: { name: e.field, message: e.message } } : {}),
					...echo()
				});
			}
			log.error('member-edit.save-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: `Could not save — ${(e as Error).message}`, ...echo() });
		}

		const verdict = username === undefined ? null : checkUsername(username);
		const ref =
			username === undefined
				? memberRef(member)
				: verdict?.ok && username.trim()
					? verdict.name
					: member.id;
		throw redirect(303, `${groupBase(url.pathname, params.slug)}/members/${ref}`);
	},

	// An admin frees a name this member retired, so another member may claim it.
	releaseUsername: async ({ request, params, locals, url }) => {
		const { group, member, admin } = await resolveEditable(params, locals, url);
		if (!admin) throw error(403, 'Group admins only');
		const name = String((await request.formData()).get('username') ?? '');
		const released = await withTransaction((client) =>
			releaseUsernameIn(client, {
				group,
				memberId: member.id,
				username: name,
				actor: actorOf(locals.user)
			})
		);
		if (!released)
			return fail(404, { releaseError: `${name} is not a retired name of this member` });
		log.info('member-edit.username-released', { groupId: group.id, memberId: member.id });
		return { released: name };
	},

	// Permanently delete this member, revoke their sessions, and — when it's the
	// owner deleting their own profile — sign them out.
	//
	// The member row is the only store, so its DELETE is the whole deletion and
	// commits with its audit row; a failure there is the action's failure, with
	// sessions untouched and the profile intact for a retry. While a sheet row
	// also existed, the order (Postgres first, then the sheet row, then the
	// rest) decided which store a half-finished delete left behind; with the
	// sheet step gone that question no longer arises. The photo and sessions
	// follow the commit, and the redirect is reserved for when they are gone too:
	// a cleanup failure is a 500. An enhanced submit reads removalPending and
	// opens the removal page; a plain POST renders the layouts next, and they
	// redirect to that page because the removal is still pending. A delete
	// reached by username redirects there itself, since the layouts look the
	// removal up by the URL's segment and the name no longer resolves.
	delete: async ({ params, locals, cookies, url }) => {
		const group = await getGroupBySlug(params.slug);
		if (!group) throw error(404, 'No such community');
		// The removal is keyed by uuid from here on, in its audit rows and on the
		// page that finishes it. A name resolves only while the member exists; a
		// retry of a pending removal arrives by uuid.
		let id = params.id;
		if (!isUuid(id)) {
			const named = await getMemberById(group.id, id);
			const user = locals.user ?? null;
			const may =
				named && (canEditMember(named, user, false) || (await resolveGroupAdmin(group, user)));
			if (!named || !may) throw error(404, 'No such member');
			id = named.id;
		}
		const outcome = await removeMember(
			group,
			id,
			locals.user ?? null,
			cookies.get(SESSION_COOKIE_NAME)
		);
		if (!outcome.ok) {
			// Reached by name, the purge took the name with the row, so the
			// layouts a plain POST renders next cannot find the pending removal;
			// send the browser to the uuid-keyed page that finishes it.
			if (outcome.stage === 'cleanup' && id !== params.id) {
				throw redirect(303, `${groupBase(url.pathname, params.slug)}/removal/${id}`);
			}
			return fail(500, {
				deleteError: outcome.message,
				removalPending: outcome.stage === 'cleanup'
			});
		}

		// Own profile → clear the cookie and land signed-out on the group's
		// landing. (An admin removing someone else stays signed in.)
		if (outcome.self) {
			cookies.delete(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
			throw redirect(303, groupBase(url.pathname, params.slug) || '/');
		}
		throw redirect(303, `${groupBase(url.pathname, params.slug)}/members`);
	}
};
