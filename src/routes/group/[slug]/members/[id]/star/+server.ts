import { error, json } from '@sveltejs/kit';
import { getMemberById } from '$lib/server/members';
import { requireDirectoryAccess } from '$lib/server/route-guards';
import { addStar, removeStar } from '$lib/server/stars';
import type { RequestHandler } from './$types';

// Toggle a star on a member for the signed-in user; the starrer is the session
// subject. The members-only gate lives in a parent layout, which a `+server.ts`
// handler never runs, so the access check is re-resolved here.
async function ctx(params: { slug: string; id: string }, locals: App.Locals) {
	const { group, user } = await requireDirectoryAccess(params, locals);
	// A uuid or a username, current or retired: the star lands on the member.
	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');
	return { groupId: group.id, memberId: member.id, starrer: user.subject };
}

export const POST: RequestHandler = async ({ params, locals }) => {
	const { groupId, memberId, starrer } = await ctx(params, locals);
	await addStar(groupId, starrer, memberId);
	return json({ ok: true, starred: true });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const { groupId, memberId, starrer } = await ctx(params, locals);
	await removeStar(groupId, starrer, memberId);
	return json({ ok: true, starred: false });
};
