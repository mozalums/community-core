import { fail } from '@sveltejs/kit';
import { updateLandingMd } from '$lib/server/groups';
import { requireGroupAdmin } from '$lib/server/route-guards';
import { renderMarkdown } from '$lib/server/markdown';
import { log } from '$lib/server/log';
import { withTransaction } from '$lib/server/postgres';
import { auditIn, actorOf } from '$lib/server/audit';
import { clipText } from '$lib/server/audit-core';
import type { Actions, PageServerLoad } from './$types';

const MAX_LEN = 50_000;

// The draft is unpublished until saved, so the load checks the grant itself;
// the admin layout's gate does not cover a leaf-only data request.
export const load: PageServerLoad = async ({ params, locals }) => {
	const group = await requireGroupAdmin(params, locals);
	const md = group.landingMd ?? '';
	return { md, preview: renderMarkdown(md) };
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		const group = await requireGroupAdmin(params, locals);

		const form = await request.formData();
		const md = String(form.get('md') ?? '');
		if (md.length > MAX_LEN) {
			return fail(400, { error: `Too long (max ${MAX_LEN} chars).`, md });
		}

		try {
			await withTransaction(async (client) => {
				const previous = await updateLandingMd(client, group.id, md);
				await auditIn(client, {
					...actorOf(locals.user),
					category: 'content',
					action: 'landing.updated',
					groupId: group.id,
					groupSlug: group.slug,
					before: clipText(previous),
					after: clipText(md)
				});
			});
			log.info('admin.landing.saved', { groupId: group.id, len: md.length });
		} catch (e) {
			log.error('admin.landing.save-failed', { groupId: group.id, error: e as Error });
			return fail(500, { error: 'Save failed — see server logs.', md });
		}

		return { saved: true, md, preview: renderMarkdown(md) };
	}
};
