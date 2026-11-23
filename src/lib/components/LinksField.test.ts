// The links field, mounted in Chromium and driven by keyboard and
// pointer: rows added and removed, a picker that lists each site's icon beside
// its name and only the sites no other row holds, and the controls a save
// posts. Server-rendered alone for the form a browser without JavaScript gets.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import { compile } from 'svelte/compiler';
import type { Page } from 'playwright-core';
import { launchChromium } from '../../../scripts/chromium';
import { coreSite, type SiteDef } from '../links';
import { pickerKey, sitesForRow } from './site-picker';

const component = path.join(import.meta.dirname, 'LinksField.svelte');
const harness = `<script>
import LinksField from ${JSON.stringify(component)};
let { initial } = $props();
</script><form id="f"><LinksField {...initial} /></form>`;

const bundle = await build({
	configFile: false,
	logLevel: 'silent',
	plugins: [
		{
			name: 'links-field-harness',
			resolveId: (id: string) => (id === 'entry' || id === 'harness' ? id : undefined),
			load(id: string) {
				if (id === 'entry')
					return `import { mount, flushSync } from 'svelte';
import Harness from 'harness';
window.start = (initial) => { mount(Harness, { target: document.body, props: { initial } }); flushSync(); };`;
				if (id === 'harness')
					return compile(harness, { filename: 'Harness.svelte', generate: 'client' }).js.code;
			},
			transform(code: string, id: string) {
				if (id.endsWith('.svelte'))
					return compile(code, { filename: id, generate: 'client' }).js.code;
			}
		}
	],
	build: {
		write: false,
		minify: false,
		rollupOptions: { input: 'entry', output: { format: 'iife', name: 'Harness' } }
	}
});
const script = (bundle as { output: { type: string; code: string }[] }).output.find(
	(x) => x.type === 'chunk'
)!.code;

const browser = await launchChromium();
after(() => browser.close());

const SITES: SiteDef[] = ['linkedin', 'github', 'mastodon'].map((id) => coreSite(id)!);

async function mounted(entries: { site: string; handle: string }[]) {
	const page: Page = await browser.newPage();
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.addScriptTag({ content: script });
	await page.evaluate((p) => (window as any).start(p), {
		name: 'links',
		label: 'Links',
		sites: SITES,
		entries
	} as never);
	return {
		page,
		// What a save would post, in order.
		posted: () =>
			page.evaluate(() =>
				[...new FormData(document.getElementById('f') as HTMLFormElement)].map(([k, v]) => [
					k,
					String(v)
				])
			),
		options: () =>
			page.evaluate(() =>
				[...document.querySelectorAll('[role="listbox"] [role="option"]')].map((o) => ({
					text: o.textContent?.trim(),
					icon: !!o.querySelector('svg[aria-hidden="true"] path')
				}))
			)
	};
}

test('the field shows only the saved rows and a [+] control', async () => {
	const f = await mounted([{ site: 'github', handle: 'ada' }]);
	assert.equal(await f.page.locator('[data-row]').count(), 1);
	assert.equal(await f.page.locator('select').count(), 0, 'a native select is still shown');
	assert.equal(await f.page.locator('button[aria-label="Add a Links row"]').count(), 1);
	assert.deepEqual(await f.posted(), [
		['links:links', ''],
		['links:site', 'github'],
		['links:handle', 'ada']
	]);
	await f.page.close();
});

test('[+] adds a row whose picker lists each site icon-first, keyboard-chosen and announced', async () => {
	const f = await mounted([{ site: 'github', handle: 'ada' }]);
	await f.page.click('button[aria-label="Add a Links row"]');
	const box = f.page.locator('#f-links-site-1');
	assert.equal(await box.getAttribute('role'), 'combobox');
	assert.equal(await box.getAttribute('aria-expanded'), 'true');
	assert.equal(await box.getAttribute('aria-haspopup'), 'listbox');
	assert.ok(
		await box.evaluate((el) => el === document.activeElement),
		'the new picker has no focus'
	);
	// GitHub is held by the first row, so the new row cannot take it.
	assert.deepEqual(await f.options(), [
		{ text: 'LinkedIn', icon: true },
		{ text: 'Mastodon', icon: true }
	]);
	await f.page.keyboard.press('ArrowDown');
	assert.equal(await box.getAttribute('aria-activedescendant'), 'f-links-site-1-opt-1');
	assert.equal(await f.page.locator('#f-links-site-1-opt-1').getAttribute('aria-selected'), 'true');
	await f.page.keyboard.press('Enter');
	assert.equal(await box.getAttribute('aria-expanded'), 'false');
	assert.match((await box.textContent()) ?? '', /Mastodon/);
	await f.page.keyboard.press('Tab');
	await f.page.keyboard.type('ada@mastodon.social');
	await f.page.keyboard.press('Tab');
	assert.deepEqual(await f.posted(), [
		['links:links', ''],
		['links:site', 'github'],
		['links:handle', 'ada'],
		['links:site', 'mastodon'],
		['links:handle', 'ada@mastodon.social']
	]);
	// LinkedIn is still free, so [+] stays, and the first row's picker offers
	// only its own site and the one nobody holds.
	assert.equal(await f.page.locator('button[aria-label="Add a Links row"]').count(), 1);
	await f.page.locator('#f-links-site-0').click();
	assert.deepEqual(
		(await f.options()).map((o) => o.text),
		['LinkedIn', 'GitHub']
	);
	await f.page.close();
});

test('remove drops the row and its site returns to the other pickers', async () => {
	const f = await mounted([
		{ site: 'github', handle: 'ada' },
		{ site: 'linkedin', handle: 'ada-l' },
		{ site: 'mastodon', handle: 'ada@mastodon.social' }
	]);
	assert.equal(await f.page.locator('button[aria-label="Add a Links row"]').count(), 0);
	await f.page.click('button[aria-label="Remove LinkedIn link"]');
	assert.deepEqual(await f.posted(), [
		['links:links', ''],
		['links:site', 'github'],
		['links:handle', 'ada'],
		['links:site', 'mastodon'],
		['links:handle', 'ada@mastodon.social']
	]);
	await f.page.locator('#f-links-site-0').click();
	assert.deepEqual(
		(await f.options()).map((o) => o.text),
		['LinkedIn', 'GitHub']
	);
	await f.page.keyboard.press('Escape');
	await f.page.click('button[aria-label="Remove GitHub link"]');
	await f.page.click('button[aria-label="Remove Mastodon link"]');
	// Every row gone still posts the marker, so the save empties the field.
	assert.deepEqual(await f.posted(), [['links:links', '']]);
	await f.page.close();
});

test('without JavaScript every row is a native select, and one blank row adds a link', async () => {
	const { createServer } = await import('vite');
	const vite = await createServer({
		server: { middlewareMode: true, watch: null, hmr: false },
		appType: 'custom',
		logLevel: 'silent'
	});
	try {
		const { default: Field } = await vite.ssrLoadModule(component);
		const { render: ssr } = await vite.ssrLoadModule('svelte/server');
		const html: string = ssr(Field, {
			props: {
				name: 'links',
				label: 'Links',
				sites: SITES,
				entries: [{ site: 'github', handle: 'ada' }]
			}
		}).body;
		const selects = [...html.matchAll(/<select[^>]*name="links:site"/g)];
		assert.equal(selects.length, 2, 'a saved row and a blank row');
		assert.match(html, /<option value="github" selected/);
		assert.match(html, /name="links:handle"[^>]*value="ada"|value="ada"[^>]*name="links:handle"/);
		assert.doesNotMatch(html, /role="combobox"/);
	} finally {
		await vite.close();
	}
});

test('the picker state offers a row only the sites no other row holds, and answers the listbox keys', () => {
	assert.deepEqual(
		sitesForRow(SITES, ['github', '', 'mastodon'], 1).map((s) => s.id),
		['linkedin']
	);
	assert.deepEqual(
		sitesForRow(SITES, ['github', 'mastodon'], 0).map((s) => s.id),
		['linkedin', 'github']
	);
	const labels = ['LinkedIn', 'GitHub', 'Mastodon'];
	const closed = { open: false, active: -1 };
	assert.deepEqual(pickerKey(closed, 'ArrowDown', labels, 1), { state: { open: true, active: 1 } });
	assert.deepEqual(pickerKey(closed, 'm', labels, -1), { state: { open: true, active: 2 } });
	assert.equal(pickerKey(closed, 'Tab', labels, -1), null);
	const open = { open: true, active: 0 };
	assert.deepEqual(pickerKey(open, 'End', labels, 0), { state: { open: true, active: 2 } });
	assert.deepEqual(pickerKey(open, 'Enter', labels, 0), { state: closed, pick: 0 });
	assert.deepEqual(pickerKey(open, 'Escape', labels, 0), { state: closed });
});
