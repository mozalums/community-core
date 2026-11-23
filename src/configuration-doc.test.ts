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

// Mail names the deployment by ORIGIN; www.<apex> is only the unset-ORIGIN
// fallback. Checked per sentence, so a correct sentence cannot vouch for a
// stale one beside it in the same section.
const sentences = (text: string) =>
	text
		.replace(/\*\*/g, '')
		.split(/\n+|(?<=\.)\s+/)
		.map((s) => s.trim())
		.filter(Boolean);

const WWW_ADDRESS = /www\.<apex>|canonical\W+www/i;
const conditional = (s: string) => /`ORIGIN`/.test(s) && /\bunset\b/i.test(s);

export function mailHostProblems(section: string): string[] {
	const all = sentences(section);
	const problems: string[] = [];
	if (!all.some((s) => /\b(mail|logo)\b/i.test(s) && /\b(follows?|are)\s+`ORIGIN`/.test(s)))
		problems.push('no sentence says mail follows ORIGIN');
	for (const s of all.filter((s) => WWW_ADDRESS.test(s) && !conditional(s)))
		problems.push(`www address given unconditionally: ${s}`);
	if (!all.some((s) => /https:\/\/www\.<apex>/.test(s) && conditional(s)))
		problems.push('the unset-ORIGIN fallback to https://www.<apex> is not documented');
	return problems;
}

const configurationPage = () => read('docs/configuration.md');

test('E54 R4: the PUBLIC_BASE_DOMAIN row says mail follows ORIGIN, with www only as the unset fallback', () => {
	const row = configurationPage().match(/^\| `PUBLIC_BASE_DOMAIN` [^\n]*$/m);
	assert.ok(row, 'docs/configuration.md has no PUBLIC_BASE_DOMAIN row');
	assert.deepEqual(mailHostProblems(row[0]), []);
});

test('E54 R4: the Hostname section says mail follows ORIGIN, with www only as the unset fallback', () => {
	const section = configurationPage().match(/^## Hostname[^\n]*\n[\s\S]*?(?=^#{2,3} )/m);
	assert.ok(section, 'docs/configuration.md has no Hostname section');
	assert.deepEqual(mailHostProblems(section[0]), []);
});

test('E54 R4: the mail-host check rejects canonical-www guidance and a missing fallback', () => {
	const stale = [
		"The session cookie, the canonical `www` URL and the mail sender follow the skin's domain.",
		'- **Canonical www URL** (`https://www.<apex>`) — used for the links and the logo in the sign-in email.'
	];
	for (const text of stale) assert.notDeepEqual(mailHostProblems(text), [], text);
	const noFallback = 'Mail links and the logo follow `ORIGIN`.';
	assert.deepEqual(mailHostProblems(noFallback), [
		'the unset-ORIGIN fallback to https://www.<apex> is not documented'
	]);
	const mixed =
		'Mail links and the logo follow `ORIGIN`, falling back to `https://www.<apex>` only when `ORIGIN` is unset. The logo is at `https://www.<apex>`.';
	assert.equal(mailHostProblems(mixed).length, 1);
});
