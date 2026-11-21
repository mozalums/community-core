import { error, json, type RequestEvent } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { canEditMember, getMemberById } from '$lib/server/members';
import { PASSKEYS_ENABLED, sessionIsFresh } from '$lib/server/passkeys';
import {
	listPasskeys,
	registerPasskey,
	registrationOptions,
	removePasskey
} from '$lib/server/passkey-store';
import { log } from '$lib/server/log';
import { isUuid } from '$lib/group-nav';
import type { RequestHandler } from './$types';

// The member's own passkeys, from their profile edit page. Never a group
// admin's: a passkey signs in as its member, so an admin who could add one
// could become anyone in the group.
async function ownMember({ params, locals }: RequestEvent<{ slug: string; id: string }>) {
	if (!PASSKEYS_ENABLED) throw error(404, 'Not found');
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such member');
	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');
	if (!locals.sessionId || !canEditMember(member, locals.user, false)) {
		// A username can be guessed where a uuid cannot. Reached by name, a profile
		// the caller may not edit answers the same 404 as a name nobody holds, so these
		// routes cannot tell a signed-in stranger which names belong to members.
		if (!isUuid(params.id)) throw error(404, 'No such member');
		throw error(403, 'You can only manage the passkeys on your own profile');
	}
	return { member, sessionId: locals.sessionId };
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (body && typeof body === 'object') return body;
	} catch {
		// fall through
	}
	throw error(400, 'Expected a JSON object');
}

export const GET: RequestHandler = async (event) => {
	const { member } = await ownMember(event);
	return json(await listPasskeys(member.id));
};

// Removing the last one is allowed: the magic link still signs the member in.
export const DELETE: RequestHandler = async (event) => {
	const { member } = await ownMember(event);
	const { id } = await jsonBody(event.request);
	if (typeof id !== 'string' || !(await removePasskey(member.id, id))) {
		return json({ error: 'gone' }, { status: 404 });
	}
	log.info('auth.passkey.removed', { memberId: member.id });
	return json({ ok: true });
};

export const POST: RequestHandler = async (event) => {
	const { member, sessionId } = await ownMember(event);
	if (!sessionIsFresh(event.locals.session)) {
		return json({ error: 'stale' }, { status: 403 });
	}
	const body = await jsonBody(event.request);
	if (body.step === 'options') {
		return json(await registrationOptions(sessionId, member));
	}
	if (body.step !== 'verify' || typeof body.response !== 'object' || !body.response) {
		throw error(400, 'Unknown step');
	}
	const outcome = await registerPasskey({
		sessionId,
		memberId: member.id,
		nickname: body.nickname,
		response: body.response as Parameters<typeof registerPasskey>[0]['response']
	});
	if (!outcome.ok) return json({ error: outcome.reason }, { status: 400 });
	return json({ ok: true });
};
