import { fail } from '@sveltejs/kit';
import { requireGroupAdmin } from '$lib/server/route-guards';
import { withTransaction } from '$lib/server/postgres';
import { actorOf } from '$lib/server/audit';
import { recordPrivateValuesFrom } from '$lib/server/audit-core';
import {
	ImportFileError,
	MAX_IMPORT_BYTES,
	MAX_IMPORT_ROWS,
	confirmPercentFrom,
	decodeUpload,
	importModeFrom,
	previewView
} from '$lib/server/import-core';
import { applyImportPlan, previewImport } from '$lib/server/member-import';
import { DEFAULT_FIELD_SCHEMA } from '$lib/server/field-schema';
import { columnHeading, LOGIN_KEY } from '$lib/server/member-export';
import { log } from '$lib/server/log';
import type { Actions, PageServerLoad } from './$types';

// Bulk-edit the roster from a spreadsheet: upload a CSV, read the diff, apply
// it. The load is gated by the admin layout; both actions re-resolve through
// requireGroupAdmin because layout loads do not run on a form dispatch.
//
// process.env rather than $env/dynamic/private keeps this module loadable
// outside Vite; adapter-node fills the latter from the former.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const MB = (MAX_IMPORT_BYTES / 1024 / 1024).toFixed(0);
const TOO_BIG = `The file is larger than ${MB} MB. A roster that size is more than the import takes in one go; split it, or ask an operator to run scripts/import-members.ts.`;
// Multipart framing around the file: the boundary lines and part headers.
const FORM_OVERHEAD = 16 * 1024;

export const load: PageServerLoad = async () => {
	return {
		loginLabel: columnHeading(LOGIN_KEY),
		labels: [...DEFAULT_FIELD_SCHEMA].sort((a, b) => a.order - b.order).map((f) => f.label),
		maxMb: MB,
		maxRows: MAX_IMPORT_ROWS
	};
};

function confirmPercent(): number | null {
	try {
		return confirmPercentFrom(process.env);
	} catch (e) {
		log.error('admin.import.config-invalid', { error: e as Error });
		return null;
	}
}
const MISCONFIGURED =
	'The import is switched off because IMPORT_CONFIRM_REMOVALS_PERCENT is set to something that is not a whole number from 0 to 50. Ask an operator to fix it.';

export const actions: Actions = {
	preview: async ({ request, params, locals }) => {
		const group = await requireGroupAdmin(params, locals);
		// The declared size first, so an oversized upload is refused before its
		// body is read, then the file's own size, then the bytes that arrived.
		const declared = Number(request.headers.get('content-length') ?? '0');
		if (declared > MAX_IMPORT_BYTES + FORM_OVERHEAD) return fail(413, { errors: [TOO_BIG] });
		const form = await request.formData();
		const mode = importModeFrom(form.get('mode'));
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { mode, errors: ['Choose a CSV file to upload.'] });
		}
		if (file.size > MAX_IMPORT_BYTES) return fail(413, { mode, errors: [TOO_BIG] });
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.length > MAX_IMPORT_BYTES) return fail(413, { mode, errors: [TOO_BIG] });

		let text: string;
		try {
			text = decodeUpload(bytes);
		} catch (e) {
			if (e instanceof ImportFileError) return fail(400, { mode, errors: [e.message] });
			throw e;
		}
		const pct = confirmPercent();
		if (pct === null) return fail(500, { mode, errors: [MISCONFIGURED] });

		try {
			const out = await withTransaction((client) =>
				previewImport(client, group, actorOf(locals.user), { text, mode, confirmPercent: pct })
			);
			if (!out.ok) return fail(400, { mode, errors: out.errors, warnings: out.warnings });
			log.info('admin.import.previewed', {
				groupId: group.id,
				mode,
				added: out.diff.added.length,
				changed: out.diff.changed.length,
				removed: out.diff.removed.length
			});
			return {
				mode,
				fileName: file.name,
				planId: out.planId,
				digest: out.digest,
				gate: out.gate,
				warnings: out.warnings,
				view: previewView(out.diff)
			};
		} catch (e) {
			log.error('admin.import.preview-failed', { groupId: group.id, error: e as Error });
			return fail(500, {
				mode,
				errors: ['The preview failed. Nothing was changed. See the server logs.']
			});
		}
	},

	apply: async ({ request, params, locals }) => {
		const group = await requireGroupAdmin(params, locals);
		const form = await request.formData();
		const planId = String(form.get('plan') ?? '');
		const digest = String(form.get('digest') ?? '');
		const typed = form.get('confirm');
		if (!UUID.test(planId) || !DIGEST.test(digest)) {
			return fail(400, {
				errors: ['That preview is not one this page made. Upload the file again.']
			});
		}
		const pct = confirmPercent();
		if (pct === null) return fail(500, { errors: [MISCONFIGURED] });

		try {
			const out = await withTransaction((client) =>
				applyImportPlan(
					client,
					group,
					actorOf(locals.user),
					{ planId, digest, typed: typeof typed === 'string' ? typed : null, confirmPercent: pct },
					{ recordPrivateValues: recordPrivateValuesFrom(process.env) }
				)
			);
			if (!out.ok) return fail(409, { errors: [out.message] });
			log.info('admin.import.applied', {
				groupId: group.id,
				runId: out.runId,
				added: out.added,
				changed: out.changed,
				removed: out.removed
			});
			return { applied: out };
		} catch (e) {
			log.error('admin.import.apply-failed', { groupId: group.id, error: e as Error });
			return fail(500, {
				errors: ['The import failed and was rolled back. Nothing was changed. See the server logs.']
			});
		}
	}
};
