import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';
import { MAX_IMPORT_BYTES } from '$lib/server/import-core';

// The import page's own behavior once the guard has let an admin through:
// the upload caps, and that what the admin is told about columns sits above
// the file picker. route-guards.test.ts covers the refusal of everyone else.

const GROUP = { id: 'g-1', slug: 'example' };
const previewImport = mock.fn(async (..._a: unknown[]) => ({
	ok: true,
	planId: '00000000-0000-4000-8000-000000000001',
	digest: 'a'.repeat(64),
	gate: { kind: 'none' },
	warnings: [],
	diff: {
		mode: 'merge',
		rows: 1,
		active: 1,
		added: [],
		changed: [],
		removed: [],
		unchanged: 1,
		errors: []
	}
}));

mock.module('$lib/server/route-guards', {
	namedExports: { requireGroupAdmin: async () => GROUP }
});
mock.module('$lib/server/postgres', {
	namedExports: { withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}) }
});
mock.module('$lib/server/audit', {
	namedExports: { actorOf: () => ({ actorSubject: 'email:admin@example.com', actorEmail: null }) }
});
mock.module('$lib/server/member-import', {
	namedExports: { previewImport, applyImportPlan: async () => ({ ok: false, message: 'x' }) }
});

const { actions } = await import('./+page.server');

beforeEach(() => previewImport.mock.resetCalls());

function event(request: unknown) {
	return {
		params: { slug: GROUP.slug },
		locals: { user: { subject: 's', email: 'e' } },
		request
	} as never;
}

function upload(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
	const body = new FormData();
	body.set('file', new File([bytes], 'roster.csv'));
	return new Request('http://localhost/group/example/admin/import?/preview', {
		method: 'POST',
		body,
		headers
	});
}

test('R13: a declared size past the cap is refused before the body is read', async () => {
	const formData = mock.fn(async () => new FormData());
	const res = (await actions.preview(
		event({ headers: new Headers({ 'content-length': String(MAX_IMPORT_BYTES * 2) }), formData })
	)) as { status: number; data: { errors: string[] } };
	assert.equal(res.status, 413);
	assert.match(res.data.errors[0], /larger than 4 MB/);
	assert.equal(formData.mock.callCount(), 0, 'the body was read anyway');
	assert.equal(previewImport.mock.callCount(), 0);
});

test('R13: a file past the cap is refused by its own size when the request does not declare one', async () => {
	const res = (await actions.preview(event(upload(new Uint8Array(MAX_IMPORT_BYTES + 1))))) as {
		status: number;
	};
	assert.equal(res.status, 413);
	assert.equal(previewImport.mock.callCount(), 0);
});

test('R13: a file at the cap is read, decoded and previewed', async () => {
	const text = 'Email\r\na@example.com\r\n';
	const bytes = new Uint8Array(MAX_IMPORT_BYTES);
	bytes.fill(0x20);
	bytes.set(new TextEncoder().encode(text));
	const res = (await actions.preview(event(upload(bytes)))) as { planId?: string };
	assert.equal(previewImport.mock.callCount(), 1);
	assert.equal(res.planId, '00000000-0000-4000-8000-000000000001');
});

test('R12: a file in a legacy code page is refused with what to do instead', async () => {
	const res = (await actions.preview(
		event(upload(new Uint8Array(Buffer.from('Email,City\r\na@example.com,K\xf6ln\r\n', 'latin1'))))
	)) as { status: number; data: { errors: string[] } };
	assert.equal(res.status, 400);
	assert.match(res.data.errors[0], /CSV UTF-8/);
	assert.equal(previewImport.mock.callCount(), 0);
});

test('R8: a mistyped IMPORT_CONFIRM_REMOVALS_PERCENT switches the import off rather than loosening it', async () => {
	process.env.IMPORT_CONFIRM_REMOVALS_PERCENT = '75';
	try {
		const res = (await actions.preview(
			event(upload(new TextEncoder().encode('Email\r\na@example.com\r\n')))
		)) as { status: number; data: { errors: string[] } };
		assert.equal(res.status, 500);
		assert.match(res.data.errors[0], /IMPORT_CONFIRM_REMOVALS_PERCENT/);
		assert.equal(previewImport.mock.callCount(), 0);
	} finally {
		delete process.env.IMPORT_CONFIRM_REMOVALS_PERCENT;
	}
});

test('R1: the mode defaults to merge, and only the literal replace selects replace', async () => {
	for (const [sent, expected] of [
		[null, 'merge'],
		['Replace', 'merge'],
		['replace', 'replace']
	] as const) {
		previewImport.mock.resetCalls();
		const body = new FormData();
		body.set('file', new File(['Email\r\na@example.com\r\n'], 'r.csv'));
		if (sent) body.set('mode', sent);
		await actions.preview(event(new Request('http://localhost/x', { method: 'POST', body })));
		const input = previewImport.mock.calls[0].arguments[3] as { mode: string };
		assert.equal(input.mode, expected, String(sent));
	}
	const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
	assert.match(page, /let mode = \$state<'merge' \| 'replace'>\('merge'\)/);
});

test('R2: the column rules are on the page, above the file picker', () => {
	const page = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8').replace(
		/\s+/g,
		' '
	);
	const picker = page.indexOf('type="file"');
	assert.ok(picker > 0);
	for (const rule of [
		'A column you leave out of the file is left alone.',
		'An empty cell clears that field',
		'Taking a column out of the file never deletes the field.',
		'A heading that is not a field is listed as a warning and its values are not saved.'
	]) {
		const at = page.indexOf(rule);
		assert.ok(at > 0, `missing: ${rule}`);
		assert.ok(at < picker, `below the file picker: ${rule}`);
	}
});

test('the admin nav links the import page', () => {
	const nav = readFileSync(new URL('../+layout.svelte', import.meta.url), 'utf8');
	assert.match(nav, /href: `\$\{base\}\/admin\/import`/);
});
