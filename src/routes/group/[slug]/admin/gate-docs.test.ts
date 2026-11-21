import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The admin page loads guard themselves because a layout's gate does not stop
// a leaf-only data request. These checks hold the two places that explain that
// rule to the next reader: the comment above each load that used to say the
// layout gated it, and the security audit's list of what requireGroupAdmin
// guards.

const here = (p: string) => new URL(p, import.meta.url);

// The comment block sitting directly above `export const load`.
function commentAboveLoad(src: string): string {
	const lines = src.split('\n');
	const at = lines.findIndex((l) => l.startsWith('export const load'));
	assert.ok(at > 0, 'no `export const load` in source');
	const block: string[] = [];
	for (let i = at - 1; i >= 0 && lines[i].startsWith('//'); i--) block.unshift(lines[i]);
	return block.map((l) => l.replace(/^\/\/\s?/, '')).join(' ');
}

test('admin access and requests loads say every admin load checks for itself', () => {
	for (const route of ['access', 'requests']) {
		const comment = commentAboveLoad(readFileSync(here(`./${route}/+page.server.ts`), 'utf8'));
		assert.doesNotMatch(
			comment,
			/gated by (the )?(parent )?admin layout|admin-gated by the parent/i,
			`${route}: still credits the layout with gating the load`
		);
		assert.match(
			comment,
			/every admin load and action checks the grant for itself/i,
			`${route}: missing the self-check rule`
		);
		assert.match(
			comment,
			/layout's gate does not stop a leaf-only `__data\.json` request/,
			`${route}: missing the leaf-only reason`
		);
	}
});

// docs-internal is not in a clean checkout, so the path is explicit and the
// check skips when the file is absent rather than failing CI.
const AUDIT = process.env.B33_AUDIT ?? 'docs-internal/SECURITY_AUDIT_2026_08_09.md';

test(
	'security audit authorization entry lists the four admin page loads',
	{ skip: existsSync(AUDIT) ? false : `${AUDIT} not present` },
	() => {
		const audit = readFileSync(AUDIT, 'utf8');
		const entry = audit.split('- **Authorization on mutations.**')[1]?.split(/\n- \*\*/)[0];
		assert.ok(entry, 'no "Authorization on mutations" entry');
		// The same paths appear again in the entry's list of guarded actions, so
		// only the sentence naming page loads counts.
		const loads = entry
			.replace(/\s+/g, ' ')
			.split(/\.\s+(?=[A-Z])/)
			.find((s) => /\bpage loads of\b/.test(s));
		assert.ok(loads, 'the entry names no page loads');
		for (const path of [
			'admin/+page.server.ts',
			'admin/access/+page.server.ts',
			'admin/requests/+page.server.ts',
			'admin/landing/+page.server.ts'
		]) {
			assert.ok(loads.includes(`\`${path}\``), `page-load list omits ${path}: ${loads}`);
		}
	}
);
