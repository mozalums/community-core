import { actorOf, auditIn } from '$lib/server/audit';
import {
	exportAuditEntry,
	exportFilename,
	exportOptionsFrom,
	loadExportMembers,
	memberCsv
} from '$lib/server/member-export';
import { withTransaction } from '$lib/server/postgres';
import { requireGroupAdmin } from '$lib/server/route-guards';
import type { RequestHandler } from './$types';

// The roster as CSV: ?private=1 adds the private fields, ?removed=1 adds
// removed members and a Status column.
//
// Admin-only by decision. The file is every member's address in one request,
// and with ?private=1 every postal address and phone number, where the directory
// otherwise meters the same data out a page at a time. The admin layout's gate
// never runs for a +server.ts handler, so it is re-resolved here before the
// first read.
//
// The private read and its audit row share a transaction: if the row cannot be
// written, no file leaves.
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const group = await requireGroupAdmin(params, locals);
	const opts = exportOptionsFrom(url.searchParams);

	const body = await withTransaction(async (client) => {
		const members = await loadExportMembers(client, group.id, opts);
		if (opts.includePrivate) {
			await auditIn(client, exportAuditEntry(group, opts, members.length, actorOf(locals.user)));
		}
		return memberCsv(members, opts);
	});

	return new Response(body, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${exportFilename(group.slug, opts, new Date())}"`,
			'cache-control': 'private, no-store, max-age=0'
		}
	});
};
