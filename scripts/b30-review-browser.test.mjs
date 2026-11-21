import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
const { createServer } = await import(pathToFileURL(resolve('node_modules/vite/dist/node/index.js')).href);
const { chromium } = await import(process.env.B30_PLAYWRIGHT_MODULE || 'playwright');
const props = {
  data: {
    group: { slug: 'example', name: 'Example' }, editName: 'Ada', gravatarHash: 'h', avatarId: null, welcome: false, canDelete: false,
    fields: [{ name: 'name', label: 'Name', value: 'Ada', required: true }, { name: 'website', label: 'Website', value: 'linkedin.com/in/ada', url: true }],
    affiliations: { asked: false, options: [], checks: {}, hasOther: false, hasPublicProfile: false, other: '', publicProfile: false, helpHtml: '' }
  }, form: null
};
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { mount } from 'svelte';
import { stores } from '/node_modules/@sveltejs/kit/src/runtime/client/client.js';
stores.page.set({url: new URL(location.href), params: {slug: 'example', id: '1'}});
import Page from '/src/routes/group/[slug]/members/[id]/edit/+page.svelte';
mount(Page, {target: document.querySelector('#app'), props: ${JSON.stringify(props)}});
window.submitted = 0;
document.querySelector('form[action="?/save"]').addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); window.submitted++; }, true);
window.ready = true;
</script></body></html>`;

test('BRANCH-REGRESSION: a stored bare URL does not block saving another field', async () => {
  let browser;
  const vite = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'error' });
  const server = createHttpServer();
  try {
    server.on('request', async (req, res) => {
      if (req.url?.startsWith('/__b30')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(await vite.transformIndexHtml('/__b30', html));
      } else vite.middlewares(req, res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({headless: true, executablePath: process.env.B30_CHROMIUM || undefined});
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('pageerror:', e.stack));
    await page.goto(`http://127.0.0.1:${server.address().port}/__b30`);
    await page.waitForFunction(() => window.ready, undefined, {timeout: 10000});
    await page.locator('[name="name"]').fill('Ada Lovelace');
    await page.getByRole('button', {name: 'Save changes', exact: true}).click();
    const actual = await page.evaluate(() => ({ submitted: window.submitted, website: document.querySelector('[name="website"]').value, typeMismatch: document.querySelector('[name="website"]').validity.typeMismatch }));
    console.log(JSON.stringify(actual));
    assert.equal(actual.submitted, 1, 'native validation blocks the save before the server can add https://');
  } finally {
    await browser?.close();
    await vite.close();
    await new Promise((r) => server.close(r));
  }
});
