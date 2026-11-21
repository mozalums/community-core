import { error, json } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { canEditMember, getMemberById } from '$lib/server/members';
import { clientAddress } from '$lib/server/client-address';
import { requestEmailChange } from '$lib/server/email-change';
import { isUuid } from '$lib/group-nav';
import type { RequestHandler } from './$types';

// Only the member themself, never a group admin: the address is how the
// account signs in, so whoever sets it can take the account.
export const POST: RequestHandler = async (event) => {
	const { params, locals } = event;
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such member');
	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');
	if (!canEditMember(member, locals.user, false)) {
		// Reached by a guessable username, refuse as if nobody held it, so the
		// route cannot tell a stranger which names belong to members.
		if (!isUuid(params.id)) throw error(404, 'No such member');
		throw error(403, 'You can only change the sign-in email on your own profile');
	}
	let body: { email?: unknown; returnTo?: unknown };
	try {
		body = await event.request.json();
	} catch {
		throw error(400, 'Expected a JSON body');
	}
	const outcome = await requestEmailChange({
		session: locals.session,
		memberId: member.id,
		current: member.email,
		next: typeof body.email === 'string' ? body.email : '',
		origin: event.url.origin,
		ip: clientAddress(event),
		returnTo: typeof body.returnTo === 'string' ? body.returnTo : '/'
	});
	if (outcome.ok) return json({ ok: true });
	const forbidden = outcome.reason === 'stale' || outcome.reason === 'passkey';
	return json({ error: outcome.reason }, { status: forbidden ? 403 : 400 });
};
