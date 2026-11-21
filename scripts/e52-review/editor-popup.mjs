import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const { compile } = require('svelte/compiler');
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const UK = '🇬🇧 +44 United Kingdom';
const harness = `<script>
import Page from './src/routes/group/[slug]/members/[id]/edit/+page.svelte';
const data = {
  group: { slug: 'example', name: 'Example' }, editName: 'Member',
  avatarId: null, gravatarHash: null,
  fields: [{ name: 'cellCode', label: 'Dialing code', private: window.privateField,
    value: '🇺🇸 +1 United States', options: 'dialingCodes', required: false }],
  affiliations: { options: [], checks: {}, other: '', publicProfile: false,
    asked: false, hasOther: false, hasPublicProfile: false }
};
</script>
<Page {data} form={null} />`;
const virtual = {
  '$app/stores': "import { writable } from 'svelte/store'; export const page = writable({ url: new URL('http://localhost/group/example/members/self/edit'), params: { id: 'self' } });",
  '$app/forms': "export function enhance(form) { const submit = e => { e.preventDefault(); window.posted = new FormData(form).getAll('cellCode'); }; form.addEventListener('submit', submit); return { destroy() { form.removeEventListener('submit', submit); } }; }",
  '$skin/skin.yaml': "export const site = { default_group: 'example' };"
};
const result = await build({
  stdin: { contents: "import { mount, flushSync } from 'svelte'; import Harness from 'audit-harness'; mount(Harness, { target: document.body }); flushSync();", resolveDir: root },
  bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['browser'], alias: { '$lib': path.join(root, 'src/lib') },
  plugins: [{ name: 'audit-svelte', setup(b) {
    b.onResolve({ filter: /^audit-harness$|^\$app\/|^\$skin\// }, ({ path: file }) => ({ path: file, namespace: 'audit' }));
    b.onLoad({ filter: /.*/, namespace: 'audit' }, ({ path: file }) => ({ contents: file === 'audit-harness' ? compile(harness, { filename: path.join(root, 'audit-harness.svelte'), generate: 'client' }).js.code : virtual[file], resolveDir: root }));
    b.onLoad({ filter: /\.svelte$/ }, ({ path: file }) => ({ contents: compile(readFileSync(file, 'utf8'), { filename: file, generate: 'client' }).js.code, resolveDir: path.dirname(file) }));
  }}]
});
const cssDir = path.join(root, '.svelte-kit/output/client/_app/immutable/assets');
const css = readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
const browser = await chromium.launch({ headless: true });
let failed = 0;
try {
  for (const privateField of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const name = `R1 ${privateField ? 'private' : 'public'} editor card exposes every filtered option to pointer input`;
    try {
      await page.goto('about:blank');
      await page.evaluate(v => { window.privateField = v; }, privateField);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: result.outputFiles[0].text });
      const box = page.getByRole('combobox');
      await box.fill('uni');
      const rows = await page.getByRole('option').evaluateAll(options => options.map(option => {
        const r = option.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { option: option.textContent.trim(), top: r.top, bottom: r.bottom, receivesPointer: option.contains(hit) };
      }));
      assert.equal(rows.length, 3);
      console.log(JSON.stringify({ name, rows }));
      assert.ok(rows.every(r => r.receivesPointer), 'the card clips filtered options out of pointer reach');
      await page.getByRole('option', { name: UK, exact: true }).click();
      await page.getByRole('button', { name: 'Save changes' }).click();
      assert.deepEqual(await page.evaluate(() => window.posted), [UK]);
      console.log('PASS', name);
    } catch (e) { failed++; console.error('FAIL', name, e.message); }
    finally { await page.close(); }
  }
} finally { await browser.close(); }
process.exitCode = failed ? 1 : 0;
