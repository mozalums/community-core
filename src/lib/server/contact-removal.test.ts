import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// B16: the contact relay is deleted, not hidden. It sent mail on the domain the
// sign-in links arrive from, for a page that never existed, so the claim is
// about what is absent from the tree. Every path resolves from this file.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(join(ROOT, rel));

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const rel = join(dir, e.name);
		if (e.isDirectory()) out.push(...sources(rel));
		else if (join(ROOT, rel) !== SELF) out.push(rel);
	}
	return out;
}
const hits = (re: RegExp, files: string[]) => files.filter((f) => re.test(read(f)));

test('R1: no route answers /api/contact or /contact', () => {
	assert.ok(!exists('src/routes/api/contact'), 'src/routes/api/contact still exists');
	assert.ok(!exists('src/routes/contact'), 'src/routes/contact exists');
	const linking = /href=["'{`]\/contact\b/;
	assert.deepEqual(hits(linking, sources('src')), [], 'a file still links to /contact');
	assert.ok(linking.test('<a href="/contact">'), 'the pattern misses');
});

test('R4: sendContactEmail is gone and nothing in src/ or deploy/ names /api/contact', () => {
	assert.doesNotMatch(read('src/lib/server/email.ts'), /sendContactEmail/);
	const tree = [...sources('src'), ...sources('deploy')];
	assert.deepEqual(hits(/\/api\/contact\b/, tree), [], 'a file still names /api/contact');
	assert.deepEqual(hits(/\bsendContactEmail\b/, tree), [], 'a file still names sendContactEmail');
	assert.deepEqual(
		hits(/\bCONTACT_TO_EMAIL\b/, [...tree, '.env.example']),
		[],
		'CONTACT_TO_EMAIL is read or documented with nothing behind it'
	);
	assert.doesNotMatch(read('src/lib/server/mail.ts'), /'contact'/, 'MailTag still has contact');
});

// docs-internal/ is untracked on purpose and no clone carries it, so these run
// only where it is present.
const DOCS = 'docs-internal';
const overlay = { skip: exists(DOCS) ? false : 'docs-internal/ is not present in this checkout' };
const section = (doc: string, id: string) =>
	read(join(DOCS, doc))
		.split(new RegExp(`^### ${id} — `, 'm'))[1]
		?.split(/^### /m)[0] ?? '';

test('R5: D6 records the deletion and A3 says the endpoint it metered is gone', overlay, () => {
	const index = read(join(DOCS, 'SECURITY_AUDIT_2026_08_18.md'));
	assert.match(index, /^\| D6 .*\(deleted\)\s*\|$/m, 'the D6 index row is not marked deleted');
	const d6 = section('SECURITY_AUDIT_2026_08_18.md', 'D6');
	assert.match(d6.split('\n')[0], /\(deleted\)$/, 'the D6 heading is not marked deleted');
	assert.match(d6, /Rejected: shipping `\/contact`/);

	const a3 = section('SECURITY_AUDIT_2026_08_09.md', 'A3');
	assert.match(a3, /`\/api\/contact` was deleted by B16/);
});
