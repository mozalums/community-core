import { error, fail } from '@sveltejs/kit';
import {
	getGroupBySlug,
	listGroupAdmins,
	grantGroupAdmin,
	revokeGroupAdmin,
	adminSubjectFor,
	lockAdminChange
} from '$lib/server/groups';
import { isAdmin } from '$lib/server/admin';
import { requireGroupAdmin } from '$lib/server/route-guards';
import { withTransaction } from '$lib/server/postgres';
import { auditIn, actorOf } from '$lib/server/audit';
import { log } from '$lib/server/log';
import type { Actions, PageServerLoad } from './$types';

// Who administers this group. The load is gated by the admin layout; the
// actions re-resolve via requireGroupAdmin because layout loads do not run on a
// form dispatch.
export const load: PageServerLoad = async ({ params, locals }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	const admins = (await listGroupAdmins(group.id)).map((a) => ({
		...a,
		global: isAdmin(a.subject)
	}));
	return { admins, self: locals.user?.subject ?? null };
};

// Refusing your own revoke means the last admin of a group cannot remove
// themselves by mistake; ADMIN_SUBJECTS stays the way back in regardless.
const SELF_REVOKE_REFUSED =
	'You cannot revoke your own admin access. Ask another admin to do it, so the group is never left without one.';
const NO_LONGER_ADMIN =
	'You no longer hold admin access to this group, so the change was not made. Another admin changed it first.';

export const actions: Actions = {
	grant: async ({ request, params, locals }) => {
		const group = await requireGroupAdmin(params, locals);
		const email = String((await request.formData()).get('email') ?? '')
			.trim()
			.toLowerCase();
		const subject = adminSubjectFor(email);
		if (!subject) return fail(400, { error: 'Enter an email address.' });
		try {
			const added = await withTransaction(async (client) => {
				if (!(await lockAdminChange(client, group.id, locals.user?.subject ?? ''))) return null;
				const added = await grantGroupAdmin(client, group.id, subject, email);
				if (added) {
					await auditIn(client, {
						...actorOf(locals.user),
						category: 'authz',
						action: 'group-admin.granted',
						groupId: group.id,
						groupSlug: group.slug,
						targetEmail: email,
						targetSubject: subject
					});
				}
				return added;
			});
			if (added === null) return fail(403, { error: NO_LONGER_ADMIN });
			log.info('admin.access.granted', { groupId: group.id, added });
			return { message: added ? `${email} is now an admin.` : `${email} was already an admin.` };
		} catch (e) {
			log.error('admin.access.grant-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: 'Grant failed — see server logs.' });
		}
	},

	revoke: async ({ request, params, locals }) => {
		const group = await requireGroupAdmin(params, locals);
		const subject = String((await request.formData()).get('subject') ?? '').trim();
		if (!subject) return fail(400, { error: 'Missing admin to revoke.' });
		if (subject.toLowerCase() === (locals.user?.subject ?? '').toLowerCase()) {
			return fail(400, { error: SELF_REVOKE_REFUSED });
		}
		try {
			const outcome = await withTransaction(async (client) => {
				if (!(await lockAdminChange(client, group.id, locals.user?.subject ?? ''))) {
					return { refused: true as const };
				}
				const removed = await revokeGroupAdmin(client, group.id, subject);
				if (removed) {
					await auditIn(client, {
						...actorOf(locals.user),
						category: 'authz',
						action: 'group-admin.revoked',
						groupId: group.id,
						groupSlug: group.slug,
						targetEmail: removed.email,
						targetSubject: removed.subject,
						before: { subject: removed.subject, email: removed.email }
					});
				}
				return { refused: false as const, removed };
			});
			if (outcome.refused) return fail(403, { error: NO_LONGER_ADMIN });
			const { removed } = outcome;
			log.info('admin.access.revoked', { groupId: group.id, removed: !!removed });
			const who = removed?.email ?? subject;
			if (!removed) return { message: `${who} did not hold a grant for this group.` };
			if (isAdmin(removed.subject)) {
				return {
					message: `Removed ${who}'s grant for this group. ${who} is listed in ADMIN_SUBJECTS and still administers every group.`
				};
			}
			return { message: `${who} is no longer an admin.` };
		} catch (e) {
			log.error('admin.access.revoke-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: 'Revoke failed — see server logs.' });
		}
	}
};
