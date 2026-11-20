import { error, fail } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { requireGroupAdmin } from '$lib/server/route-guards';
import { listRequests, approveRequest, denyRequest } from '$lib/server/requests';
import { deleteUserSessions } from '$lib/server/session-store';
import { sendMembershipApprovedEmail } from '$lib/server/email';
import { actorOf } from '$lib/server/audit';
import { log } from '$lib/server/log';
import type { Actions, PageServerLoad } from './$types';

// The load is admin-gated by the parent admin layout; the actions below are
// not, because layout loads do not run on a form dispatch, so each re-resolves
// via requireGroupAdmin.
export const load: PageServerLoad = async ({ params }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	try {
		return { requests: await listRequests(group), loadError: null };
	} catch (e) {
		log.warn('requests.list-failed', { groupId: group.id, error: e as Error });
		return { requests: [], loadError: (e as Error).message };
	}
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_PENDING =
	'That request is no longer pending, so nothing was changed. Another admin may have decided it already.';

// The id is the lookup key, so a click acts on the request that was rendered
// and never on one created for the same address since. The email rides along
// only to word the confirmation.
function decision(form: FormData): { id: string; shown: string } | null {
	const id = String(form.get('id') ?? '').trim();
	if (!UUID.test(id)) return null;
	return { id, shown: String(form.get('email') ?? '').trim() };
}

export const actions: Actions = {
	approve: async ({ request, params, locals, url }) => {
		const group = await requireGroupAdmin(params, locals);
		const d = decision(await request.formData());
		if (!d) return fail(400, { error: 'Missing request id.' });
		let approved;
		try {
			approved = await approveRequest(group, d.id, actorOf(locals.user));
		} catch (e) {
			log.error('requests.approve-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: `Could not approve — ${(e as Error).message}` });
		}
		if (!approved) return fail(409, { error: NOT_PENDING });
		log.info('requests.approved', { groupId: group.id, requestId: d.id });
		// Outside the transaction and never fatal: mail cannot be rolled back, and
		// the person is a member whether or not the notice arrives.
		try {
			await sendMembershipApprovedEmail({
				to: approved.email,
				groupName: group.name,
				signInUrl: `${url.origin}/login`
			});
		} catch (e) {
			log.error('requests.approved-email-failed', { groupId: group.id, error: e as Error });
		}
		return { message: `Approved ${d.shown || approved.email}.` };
	},

	deny: async ({ request, params, locals }) => {
		const group = await requireGroupAdmin(params, locals);
		const form = await request.formData();
		const d = decision(form);
		if (!d) return fail(400, { error: 'Missing request id.' });
		const reason = String(form.get('reason') ?? '').trim() || null;
		let denied;
		try {
			denied = await denyRequest(group, d.id, actorOf(locals.user), reason);
		} catch (e) {
			log.error('requests.deny-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: `Could not deny — ${(e as Error).message}` });
		}
		if (!denied) return fail(409, { error: NOT_PENDING });
		// Outside the transaction and never fatal: a rollback could not restore a
		// revoked session, and the denial stands whether or not Redis answers.
		let revoked = 0;
		try {
			revoked = await deleteUserSessions(`email:${denied.email.trim().toLowerCase()}`);
		} catch (e) {
			log.error('requests.deny-revoke-failed', { groupId: group.id, error: e as Error });
		}
		log.info('requests.denied', { groupId: group.id, requestId: d.id, sessionsRevoked: revoked });
		return { message: `Denied ${d.shown || denied.email}.` };
	}
};
