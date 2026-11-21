import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { compile } from 'svelte/compiler';
import { chromium } from 'playwright-core';

const profileFile = resolve('src/routes/group/[slug]/members/[id]/+page.svelte');
const wrapper = `<script>
import Page from ${JSON.stringify(profileFile)};
let { initial } = $props();
let data = $state(initial);
export function update(next) { data = next; }
</script><Page {data} />`;
const bundle = await build({
  configFile: false,
  logLevel: 'silent',
  plugins: [{
    name: 'e51-review',
    resolveId(id) {
      if (['review-entry', 'review-wrapper', '$app/stores', '$skin/skin.yaml'].includes(id)) return id;
      if (id.startsWith('$lib/')) {
        const file = resolve('src/lib', id.slice(5));
        return existsSync(file) ? file : `${file}.ts`;
      }
    },
    load(id) {
      if (id === 'review-entry') return `import { mount, flushSync } from 'svelte';
        import Wrapper from 'review-wrapper';
        window.start = initial => { window.app = mount(Wrapper, {target: document.body, props: {initial}}); flushSync(); };
        window.update = data => { window.app.update(data); flushSync(); };`;
      if (id === 'review-wrapper') return compile(wrapper, {filename: 'Review.svelte', generate: 'client'}).js.code;
      if (id === '$app/stores') return `export const page = {subscribe(run) {run({url: new URL('http://localhost/group/g/members/a')}); return () => {};}};`;
      if (id === '$skin/skin.yaml') return `export const site = {default_group: 'g'};`;
    },
    transform(code, id) {
      if (id.endsWith('.svelte')) return compile(code, {filename: id, generate: 'client'}).js.code;
    }
  }],
  build: {write: false, minify: false, rollupOptions: {input: 'review-entry', output: {format: 'iife', name: 'Review'}}}
});
const script = bundle.output.find(x => x.type === 'chunk').code;
const data = (id, starred) => ({
  group: {slug: 'g', name: 'Group'},
  profile: {id, name: id, handle: null, email: null, bio: null, details: [], avatarId: null},
  canEdit: false, privateFields: null, starred
});

async function fixture(fn) {
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({content: script});
    await page.evaluate(() => {
      window.calls = [];
      window.pending = [];
      window.fetch = (url, init) => {
        window.calls.push({url, method: init.method});
        return new Promise(resolve => window.pending.push(status => resolve(new Response('{}', {status}))));
      };
    });
    const pressed = () => page.locator('button[aria-pressed]').getAttribute('aria-pressed');
    const settle = status => page.evaluate(status => window.pending.shift()(status), status);
    await fn({page, pressed, settle});
  } finally { await browser.close(); }
}

test('R4 browser: profile star clicks POST, DELETE, and roll back a failed request', async () => {
  await fixture(async ({page, pressed, settle}) => {
    await page.evaluate(d => window.start(d), data('a', false));
    for (const [method, status, optimistic, final] of [['POST',200,'true','true'], ['DELETE',200,'false','false'], ['POST',403,'true','false']]) {
      await page.locator('button[aria-pressed]').click();
      assert.equal(await pressed(), optimistic);
      assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), {url:'/group/g/members/a/star', method});
      await settle(status);
      assert.equal(await pressed(), final);
    }
  });
});

test('R3 regression: navigating to another unstarred profile clears the first profile override', async () => {
  await fixture(async ({page, pressed, settle}) => {
    await page.evaluate(d => window.start(d), data('a', false));
    await page.locator('button[aria-pressed]').click();
    await settle(200);
    assert.equal(await pressed(), 'true');
    await page.evaluate(d => window.update(d), data('b', false));
    assert.equal(await page.locator('h1').textContent(), 'b');
    assert.equal(await pressed(), 'false', 'profile b inherited profile a optimistic star');
    await page.locator('button[aria-pressed]').click();
    assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), {url:'/group/g/members/b/star', method:'POST'});
  });
});

test('R3 regression: a failed request for the previous profile cannot change the current profile', async () => {
  await fixture(async ({page, pressed, settle}) => {
    await page.evaluate(d => window.start(d), data('a', false));
    await page.locator('button[aria-pressed]').click();
    await page.evaluate(d => window.update(d), data('b', true));
    assert.equal(await pressed(), 'true');
    await settle(403);
    assert.equal(await pressed(), 'true', 'profile a rollback overwrote profile b server state');
  });
});
