import { error, json } from '@sveltejs/kit';
import { getGroupBySlug, resolveGroupAdmin, type Group } from '$lib/server/groups';
import { getMemberById, canEditMember, type Member } from '$lib/server/members';
import { putAvatar, deleteAvatar, ACCEPTED_TYPES, MAX_AVATAR_BYTES } from '$lib/server/avatars';
import { normalizeAvatar } from '$lib/server/avatar-image';
import { updateMember } from '$lib/server/member-write';
import { actorOf } from '$lib/server/audit-core';
import { optionalFieldByRole } from '$lib/server/field-schema';
import { checkProfileUrl } from '$lib/server/profile-url';
import { log } from '$lib/server/log';
import { isUuid } from '$lib/group-nav';
import type { RequestHandler } from './$types';

// The photo's URL is a member field like any other, written through the same
// transaction as a profile save, so a CSV export carries it. The id is the
// one putAvatar returns and never changes for a given row, so replacing a
// photo leaves the URL correct without a second write. A failed write fails
// the request: the bytes are stored by then, and a retry writes the same URL.
// A skin with no avatar-role field has no such column to carry: the photo is
// stored and served all the same, and nothing is written to the member row.
const AVATAR_KEY = optionalFieldByRole('avatar')?.key;

// Own-profile-or-admin gate, mirroring the edit page's resolveEditable.
async function editableMember(
	params: { slug: string; id: string },
	locals: App.Locals
): Promise<{ group: Group; member: Member; admin: boolean }> {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');
	const admin = await resolveGroupAdmin(group, locals.user ?? null);
	// A username can be guessed where a uuid cannot. Reached by name, a profile
	// the caller may not edit answers the same 404 as a name nobody holds, so these
	// routes cannot tell a signed-in stranger which names belong to members.
	if (!canEditMember(member, locals.user, admin)) {
		if (!isUuid(params.id)) throw error(404, 'No such member');
		throw error(403, 'You can only edit your own profile');
	}
	return { group, member, admin };
}

function recordAvatarUrl(
	group: Group,
	member: Member,
	admin: boolean,
	user: App.Locals['user'],
	value: string
): Promise<number> {
	if (!AVATAR_KEY) return Promise.resolve(0);
	return updateMember(
		group,
		member.id,
		{ [AVATAR_KEY]: value },
		actorOf(user),
		{ admin },
		{
			allow: [AVATAR_KEY]
		}
	);
}

export const POST: RequestHandler = async ({ params, locals, request, url }) => {
	const { group, member, admin } = await editableMember(params, locals);

	const form = await request.formData();
	const file = form.get('photo');
	if (!(file instanceof File)) return json({ error: 'No file uploaded.' }, { status: 400 });
	if (!ACCEPTED_TYPES.includes(file.type)) {
		return json({ error: 'Use a JPEG, PNG, or WebP image.' }, { status: 400 });
	}
	if (file.size > MAX_AVATAR_BYTES) {
		return json({ error: 'Image must be 2 MB or smaller.' }, { status: 400 });
	}
	// The recorded address passes the same check as a typed one, so a site
	// served over plain http is refused here, before the bytes are stored
	// under a URL the member row would then refuse.
	const recorded = AVATAR_KEY ? checkProfileUrl(`${url.origin}/avatar/x`) : null;
	if (recorded && !recorded.ok) {
		log.error('avatar.origin-refused', { memberId: member.id, origin: url.origin });
		return json(
			{ error: `This site's address ${recorded.reason}, so a photo cannot be recorded.` },
			{ status: 500 }
		);
	}
	const bytes = Buffer.from(await file.arrayBuffer());
	if (bytes.length > MAX_AVATAR_BYTES) {
		return json({ error: 'Image must be 2 MB or smaller.' }, { status: 400 });
	}

	const image = await normalizeAvatar(bytes, file.type, MAX_AVATAR_BYTES);
	if (!image.ok) {
		log.warn('avatar.refused', { memberId: member.id, bytes: bytes.length, type: file.type });
		return json({ error: image.error }, { status: 400 });
	}

	const avatarId = await putAvatar(member.email, image.bytes, image.contentType);
	log.info('avatar.uploaded', {
		memberId: member.id,
		bytes: image.bytes.length,
		type: image.contentType
	});
	await recordAvatarUrl(group, member, admin, locals.user, `${url.origin}/avatar/${avatarId}`);
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const { group, member, admin } = await editableMember(params, locals);
	await deleteAvatar(member.email);
	log.info('avatar.removed', { memberId: member.id });
	await recordAvatarUrl(group, member, admin, locals.user, '');
	return json({ ok: true });
};
