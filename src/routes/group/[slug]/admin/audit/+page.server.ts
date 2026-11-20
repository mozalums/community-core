import { requireGroupAdmin } from '$lib/server/route-guards';
import { query } from '$lib/server/postgres';
import { AUDIT_CATEGORIES, groupByRun, isAuditCategory } from '$lib/server/audit-core';
import type { PageServerLoad } from './$types';

const PAGE_SIZE = 50;

type Row = {
	id: string;
	at: Date;
	category: string;
	action: string;
	actor_subject: string | null;
	actor_email: string | null;
	target_email: string | null;
	target_id: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	meta: Record<string, unknown> | null;
	run_id: string | null;
};

// Read-only. The admin layout gates the page render, and this re-resolves the
// grant itself as well: the trail names who was acted on, so it is the one
// admin load that should not lean on a sibling for its gate.
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const group = await requireGroupAdmin(params, locals);

	const rawCategory = url.searchParams.get('category') ?? '';
	const category = isAuditCategory(rawCategory) ? rawCategory : '';
	const email = (url.searchParams.get('email') ?? '').trim();
	const page = Math.max(1, Math.floor(Number(url.searchParams.get('page')) || 1));

	const where = ['group_id = $1'];
	const args: unknown[] = [group.id];
	if (category) {
		args.push(category);
		where.push(`category = $${args.length}`);
	}
	if (email) {
		args.push(email);
		where.push(`target_email = $${args.length}`);
	}
	args.push(PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);

	const { rows } = await query<Row>(
		`SELECT id::text, at, category, action, actor_subject, actor_email, target_email,
		        target_id, before, after, meta, run_id
		   FROM audit_event
		  WHERE ${where.join(' AND ')}
		  ORDER BY at DESC, id DESC
		  LIMIT $${args.length - 1} OFFSET $${args.length}`,
		args
	);

	const events = rows.slice(0, PAGE_SIZE).map((r) => ({
		id: r.id,
		// Pinned to ISO, as on the overview: a Date renders in the server's zone
		// and then flips to the browser's on hydration.
		at: new Date(r.at).toISOString(),
		category: r.category,
		action: r.action,
		actor: r.actor_email ?? r.actor_subject,
		targetEmail: r.target_email,
		targetId: r.target_id,
		before: r.before,
		after: r.after,
		meta: r.meta ?? {},
		runId: r.run_id
	}));

	return {
		blocks: groupByRun(events),
		categories: AUDIT_CATEGORIES,
		filter: { category, email },
		page,
		hasMore: rows.length > PAGE_SIZE
	};
};
