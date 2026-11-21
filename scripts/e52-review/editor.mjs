import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const { compile } = require('svelte/compiler');
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const trunk = process.argv.includes('--trunk');
const source = file => trunk && ['src/lib/data/field-options.ts', 'src/routes/group/[slug]/members/[id]/edit/+page.svelte'].includes(path.relative(root, file))
  ? execFileSync('git', ['show', `main:${path.relative(root, file)}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8');
const UK = '🇬🇧 +44 United Kingdom';
const US = '🇺🇸 +1 United States';
const harness = `<script>
import Page from './src/routes/group/[slug]/members/[id]/edit/+page.svelte';
import { page } from '$app/stores';
let data = $state({
  group: { slug: 'example', name: 'Example' }, editName: 'Other member',
  avatarId: null, gravatarHash: null,
  fields: [{ name: 'cellCode', label: 'Dialing code', private: true, value: '🇺🇸 +1 United States', options: 'dialingCodes', required: false }],
  affiliations: { options: [], checks: {}, other: '', publicProfile: false, asked: false, hasOther: false, hasPublicProfile: false }
});
window.changeMember = (value) => {
  page.set({ url: new URL('http://localhost/group/example/members/self/edit'), params: { id: 'self' } });
  data = { ...data, editName: 'Self', fields: [{ ...data.fields[0], value }] };
};
</script>
<Page {data} form={null} />`;
const virtual = {
  '$app/stores': "import { writable } from 'svelte/store'; export const page = writable({ url: new URL('http://localhost/group/example/members/other/edit'), params: { id: 'other' } });",
  '$app/forms': "export function enhance(form) { const submit = e => { e.preventDefault(); window.posted = new FormData(form).getAll('cellCode'); }; form.addEventListener('submit', submit); return { destroy() { form.removeEventListener('submit', submit); } }; }",
  '$skin/skin.yaml': "export const site = { default_group: 'example' };"
};
const result = await build({
  stdin: { contents: "import { mount, flushSync } from 'svelte'; import Harness from 'audit-harness'; mount(Harness, { target: document.body }); flushSync();", resolveDir: root },
  bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['browser'], alias: { '$lib': path.join(root, 'src/lib') },
  plugins: [{ name: 'audit-svelte', setup(b) {
    b.onResolve({ filter: /^audit-harness$|^\$app\/|^\$skin\// }, ({ path: file }) => ({ path: file, namespace: 'audit' }));
    b.onLoad({ filter: /.*/, namespace: 'audit' }, ({ path: file }) => ({ contents: file === 'audit-harness' ? compile(harness, { filename: path.join(root, 'audit-harness.svelte'), generate: 'client' }).js.code : virtual[file], resolveDir: root }));
    b.onLoad({ filter: /\.svelte$/ }, ({ path: file }) => ({ contents: compile(source(file), { filename: file, generate: 'client' }).js.code, resolveDir: path.dirname(file) }));
    b.onLoad({ filter: /field-options\.ts$/ }, ({ path: file }) => ({ contents: source(file), loader: 'ts', resolveDir: path.dirname(file) }));
  }}]
});
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('PAGE ERROR', e.message));
  await page.goto('about:blank');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.locator('#f-cellCode').waitFor();
  assert.equal(await page.locator('#f-cellCode').inputValue(), US);
  await page.evaluate(v => window.changeMember(v), UK);
  await page.getByRole('button', { name: 'Save changes' }).click();
  const actual = await page.evaluate(() => ({ title: document.title, formValue: window.posted }));
  console.log(JSON.stringify({ tree: trunk ? 'main' : 'HEAD', ...actual }));
  assert.deepEqual(actual.formValue, [UK]);
} finally { await browser.close(); }
