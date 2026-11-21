import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright-core';
const root = process.cwd();
const require = createRequire(path.join(root, 'package.json'));
const { compile } = require('svelte/compiler');
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const UK = '🇬🇧 +44 United Kingdom';
const US = '🇺🇸 +1 United States';
const harness = `<script>
import Combobox from './src/lib/components/Combobox.svelte';
import { DIALING_CODES, matchDialingCode } from './src/lib/data/field-options.ts';
let current = $state(window.initialValue);
window.replaceValue = (v) => { current = v; };
const options = $derived(current && !DIALING_CODES.includes(current) ? [current, ...DIALING_CODES] : DIALING_CODES);
</script>
<form onsubmit={(e) => { e.preventDefault(); window.posted = new FormData(e.currentTarget).getAll('cellCode'); }}>
<label for="f-cellCode">Dialing code</label>
<Combobox id="f-cellCode" name="cellCode" value={current} {options} match={matchDialingCode} />
<button type="submit" style="margin-top:280px">Save</button>
</form>`;
const result = await build({
  stdin: { contents: "import { mount, flushSync } from 'svelte'; import Harness from 'audit-harness'; mount(Harness, { target: document.body }); flushSync();", resolveDir: root },
  bundle: true, write: false, format: 'iife', platform: 'browser', conditions: ['browser'],
  plugins: [{ name: 'audit-svelte', setup(b) {
    b.onResolve({ filter: /^audit-harness$/ }, () => ({ path: 'audit-harness', namespace: 'audit' }));
    b.onLoad({ filter: /.*/, namespace: 'audit' }, () => ({ contents: compile(harness, { filename: path.join(root, 'audit-harness.svelte'), generate: 'client' }).js.code, resolveDir: root }));
    b.onLoad({ filter: /\.svelte$/ }, ({ path: file }) => ({ contents: compile(readFileSync(file, 'utf8'), { filename: file, generate: 'client' }).js.code, resolveDir: path.dirname(file) }));
  }}]
});
const cssDir = path.join(root, '.svelte-kit/output/client/_app/immutable/assets');
const css = readdirSync(cssDir).filter(f => f.endsWith('.css')).map(f => readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
let failed = 0;
async function scenario(name, run, initial = US) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', e => console.error('PAGE ERROR', e.message));
  try {
    await page.goto('about:blank');
    await page.evaluate(v => { window.initialValue = v; }, initial);
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: result.outputFiles[0].text });
    const box = page.getByRole('combobox');
    await box.waitFor();
    await run(page, box);
    console.log('PASS', name);
  } catch(e) { failed++; console.log('FAIL', name, e.message); }
  finally { await page.close(); }
}
try {
  await scenario('R1/R3/R5 keyboard filter select Escape and submitted FormData', async (page, box) => {
    await box.focus();
    await box.press('ControlOrMeta+A');
    await box.pressSequentially('uni');
    await box.press('ArrowDown');
    await box.press('End');
    await box.press('Home');
    await box.press('ArrowDown');
    await box.press('Enter');
    assert.equal(await box.inputValue(), UK);
    await box.press('ControlOrMeta+A');
    await box.pressSequentially('fra');
    await box.press('Escape');
    assert.equal(await box.inputValue(), UK);
    await box.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.posted), [UK]);
  });
  await scenario('R3 preserve off-list value on submit', async (page, box) => {
    assert.equal(await box.inputValue(), '+999');
    await page.getByRole('button', { name: 'Save' }).click();
    assert.deepEqual(await page.evaluate(() => window.posted), ['+999']);
  }, '+999');
  await scenario('click activation selects the option', async (page, box) => {
    await box.fill('44');
    await page.getByRole('option', { name: UK, exact: true }).evaluate(el => el.click());
    await page.getByRole('button', { name: 'Save' }).click();
    assert.deepEqual(await page.evaluate(() => window.posted), [UK]);
  });
  await scenario('keyboard filtering keeps active option visible', async (page, box) => {
    await box.focus();
    await box.press('ArrowDown');
    await box.press('End');
    await box.press('ControlOrMeta+A');
    await box.press('Backspace');
    const rects = await page.evaluate(() => {
      const input = document.querySelector('[role=combobox]');
      const active = document.getElementById(input.getAttribute('aria-activedescendant')).getBoundingClientRect();
      const list = document.querySelector('[role=listbox]').getBoundingClientRect();
      return { activeTop: active.top, activeBottom: active.bottom, listTop: list.top, listBottom: list.bottom };
    });
    assert.ok(rects.activeTop >= rects.listTop && rects.activeBottom <= rects.listBottom, JSON.stringify(rects));
  });
  await scenario('reused editor submits its new current value', async (page, box) => {
    await page.evaluate(v => window.replaceValue(v), UK);
    await page.getByRole('button', { name: 'Save' }).click();
    assert.deepEqual(await page.evaluate(() => window.posted), [UK]);
  });
  await scenario('ordinary pointer selection works', async (page, box) => {
    await box.fill('44');
    await page.getByRole('option', { name: UK, exact: true }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    assert.deepEqual(await page.evaluate(() => window.posted), [UK]);
  });
} finally { await browser.close(); }
process.exitCode = failed ? 1 : 0;
