import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';

// The E52 review's browser reproductions, run as the review wrote them. The
// preload supplies Chromium where the macOS Chrome they name is absent.
const root = path.resolve(import.meta.dirname, '../../..');
// node:test marks its children with NODE_TEST_CONTEXT, and a nested `node --test`
// that inherits it skips every file and exits 0, so coverage.mjs would pass blind.
const { NODE_TEST_CONTEXT: _, ...env } = process.env;
const run = (script: string) =>
	spawnSync(
		process.execPath,
		['--import', 'tsx', '--import', './scripts/chromium.ts', `scripts/e52-review/${script}`],
		{ cwd: root, encoding: 'utf8', env }
	);
const passes = (script: string) => {
	const r = run(script);
	assert.equal(r.status, 0, `${script} exited ${r.status}\n${r.stdout}${r.stderr}`);
};

// probe.mjs styles its page with the built CSS, which a fresh checkout lacks
// until `pnpm build`; the verify command and CI both run the tests first.
before(() => {
	if (existsSync(path.join(root, '.svelte-kit/output/client/_app/immutable/assets'))) return;
	const vite = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
		cwd: root,
		encoding: 'utf8'
	});
	assert.equal(vite.status, 0, vite.stdout + vite.stderr);
});

test('E52 R1/R3/R5 review: probe.mjs keyboard, click, visibility and reuse scenarios', () =>
	passes('probe.mjs'));
test('E52 R3 review: editor.mjs reused edit page posts the new member value', () =>
	passes('editor.mjs'));
test('E52 R1 review: editor-popup.mjs editor cards expose every filtered option to pointer input', () =>
	passes('editor-popup.mjs'));
test('E52 R5 review: coverage.mjs mapped keyboard test rejects a wrong field name', () =>
	passes('coverage.mjs'));
test('E52 R1 review: accessible-names.mjs editor cards name the combobox and its listbox', () =>
	passes('accessible-names.mjs'));
