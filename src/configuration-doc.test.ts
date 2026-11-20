import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// docs/configuration.md is complete by construction: every variable the code
// reads under src/ and scripts/ has a row in its table. Test files and their
// fixtures are left out, because what they read (a scratch database URL, a
// report path) configures the test, not the platform.

const ROOT = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

// `env.X` and `process.env.X` are the two forms the requirement names. `e.X` is
// the third the tree uses: mail.ts reads the transport from an env record it
// was handed under that name.
const READ = /\b(?:process\.env|env|e)\.([A-Z][A-Z0-9_]*)\b/g;

export function readsIn(source: string): string[] {
	return [...source.matchAll(READ)].map((m) => m[1]);
}

export function documented(page: string): Set<string> {
	return new Set([...page.matchAll(/^\| `([A-Z][A-Z0-9_]*)` +\|/gm)].map((m) => m[1]));
}

function codeReads(): Map<string, string> {
	const files = execFileSync('git', ['ls-files', 'src', 'scripts'], {
		cwd: ROOT,
		encoding: 'utf8'
	})
		.split('\n')
		.filter((f) => /\.(ts|js|mjs|svelte)$/.test(f) && !/\.test\.|fixture/.test(f));
	const where = new Map<string, string>();
	for (const file of files) {
		for (const name of readsIn(read(file))) if (!where.has(name)) where.set(name, file);
	}
	return where;
}

test('E43 R3: every variable read under src and scripts has a row in docs/configuration.md', () => {
	const page = documented(read('docs/configuration.md'));
	const reads = codeReads();
	const missing = [...reads].filter(([name]) => !page.has(name)).map(([n, f]) => `${n} (${f})`);
	assert.deepEqual(missing, [], 'read by the code, absent from docs/configuration.md');
	// The three that were read and documented nowhere before the page existed.
	for (const name of ['ADDRESS_HEADER', 'XFF_DEPTH', 'LOREM_BUILD_SHA']) {
		assert.ok(reads.has(name), `${name} is no longer read; the collector may be broken`);
		assert.ok(page.has(name), `${name} has no row`);
	}
	assert.ok(reads.size >= 30, `the collector found only ${reads.size} variables`);
});

test('E43 R3: the collector sees each read form, and a row is what counts as documented', () => {
	const source = [
		"const a = env.ALPHA_ONE;",
		"const b = process.env.BETA_TWO || 'x';",
		"const c = (e.GAMMA ?? '').trim();",
		"const d = someenv.NOT_THIS;",
		"const s = 'env.lowercase';"
	].join('\n');
	assert.deepEqual(readsIn(source), ['ALPHA_ONE', 'BETA_TWO', 'GAMMA']);

	const page = '| `ALPHA_ONE` | text |\nBETA_TWO in prose is not a row.\n';
	assert.deepEqual([...documented(page)], ['ALPHA_ONE']);
});
