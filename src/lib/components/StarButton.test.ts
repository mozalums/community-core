// Mounts StarButton in Chromium and drives it through real clicks against a
// stubbed fetch whose requests stay open until the test settles them, so the
// optimistic state, the request and the rollback are all read from the DOM.
// Self-contained on purpose: scripts/e51-click-coverage.test.mjs copies this
// file beside a mutated component and expects it to run from there.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { compile } from 'svelte/compiler';
import type { Page } from 'playwright-core';

// The browser comes from the repository's own bootstrap, which installs the pinned
// Chromium on an empty cache. Found by walking up to package.json rather than by a
// relative import, so the copy the click-coverage guard runs resolves it too.
function repoRoot(dir: string): string {
	while (!existsSync(path.join(dir, 'package.json'))) {
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`no package.json above ${import.meta.dirname}`);
		dir = parent;
	}
	return dir;
}
const { launchChromium } = (await import(
	pathToFileURL(path.join(repoRoot(import.meta.dirname), 'scripts', 'chromium.ts')).href
)) as typeof import('../../../scripts/chromium');

const component = path.join(import.meta.dirname, 'StarButton.svelte');
const harness = `<script>
import StarButton from ${JSON.stringify(component)};
let { initial } = $props();
let props = $state(initial);
export function update(next) { props = next; }
</script><StarButton base={props.base} memberId={props.memberId} starred={props.starred} />`;

const bundle = await build({
	configFile: false,
	logLevel: 'silent',
	plugins: [
		{
			name: 'star-button-harness',
			resolveId: (id: string) => (id === 'entry' || id === 'harness' ? id : undefined),
			load(id: string) {
				if (id === 'entry')
					return `import { mount, flushSync } from 'svelte';
import Harness from 'harness';
window.start = (initial) => { window.app = mount(Harness, { target: document.body, props: { initial } }); flushSync(); };
window.update = (next) => { window.app.update(next); flushSync(); };`;
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

type Props = { base: string; memberId: string; starred: boolean };
const props = (memberId: string, starred: boolean): Props => ({
	base: '/group/g',
	memberId,
	starred
});

async function mounted(initial: Props) {
	const page: Page = await browser.newPage();
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.addScriptTag({ content: script });
	await page.evaluate(() => {
		const w = window as any;
		w.calls = [];
		w.pending = [];
		w.fetch = (url: string, init: RequestInit) => {
			w.calls.push({ url, method: init.method });
			return new Promise((resolve, reject) =>
				w.pending.push((status: number) =>
					status ? resolve(new Response('{}', { status })) : reject(new TypeError('offline'))
				)
			);
		};
	});
	await page.evaluate((p) => (window as any).start(p), initial);
	const button = page.locator('button[aria-pressed]');
	return {
		page,
		click: () => button.click(),
		pressed: () => button.getAttribute('aria-pressed'),
		lastCall: () => page.evaluate(() => (window as any).calls.at(-1)),
		calls: () => page.evaluate(() => (window as any).calls.length),
		// 0 rejects the request as a network failure.
		settle: (status: number) => page.evaluate((s) => (window as any).pending.shift()(s), status),
		update: (next: Props) => page.evaluate((p) => (window as any).update(p), next),
		button
	};
}

test('R4: a click stars at once and POSTs to the member star endpoint', async () => {
	const b = await mounted(props('m1', false));
	await b.click();
	assert.equal(await b.pressed(), 'true', 'not optimistic: unstarred while the request is open');
	assert.deepEqual(await b.lastCall(), { url: '/group/g/members/m1/star', method: 'POST' });
	await b.settle(200);
	assert.equal(await b.pressed(), 'true');
	assert.equal(await b.button.getAttribute('aria-label'), 'Unstar');
	await b.page.close();
});

test('R4: a click on a starred member unstars at once and DELETEs', async () => {
	const b = await mounted(props('m1', true));
	await b.click();
	assert.equal(await b.pressed(), 'false', 'not optimistic: starred while the request is open');
	assert.deepEqual(await b.lastCall(), { url: '/group/g/members/m1/star', method: 'DELETE' });
	await b.settle(200);
	assert.equal(await b.pressed(), 'false');
	await b.page.close();
});

test('R4: a refused or failed request rolls the star back', async () => {
	for (const [start, status] of [
		[false, 403],
		[true, 500],
		[false, 0]
	] as const) {
		const b = await mounted(props('m1', start));
		await b.click();
		assert.equal(await b.pressed(), String(!start));
		await b.settle(status);
		assert.equal(await b.pressed(), String(start), `${status || 'network'} failure kept the flip`);
		await b.page.close();
	}
});

test('R4: a request for one member cannot change the star of the member shown after it', async () => {
	const b = await mounted(props('m1', false));
	await b.click();
	await b.update(props('m2', true));
	assert.equal(await b.pressed(), 'true', 'm2 did not take its server value');
	await b.settle(403);
	assert.equal(await b.pressed(), 'true', 'm1 rollback overwrote m2');
	await b.click();
	assert.deepEqual(await b.lastCall(), { url: '/group/g/members/m2/star', method: 'DELETE' });
	await b.page.close();
});

test('R4: switching member while a request is open drops the optimistic flip', async () => {
	const b = await mounted(props('m1', false));
	await b.click();
	await b.update(props('m2', false));
	assert.equal(await b.pressed(), 'false', 'm2 inherited m1 optimistic star');
	await b.settle(200);
	assert.equal(await b.pressed(), 'false', 'm1 success starred m2');
	assert.equal(await b.calls(), 1);
	await b.page.close();
});

test('R1: the button renders the state it was given', async () => {
	for (const starred of [true, false]) {
		const b = await mounted(props('m1', starred));
		assert.equal(await b.pressed(), String(starred));
		assert.equal(await b.button.getAttribute('aria-label'), starred ? 'Unstar' : 'Star');
		assert.equal(
			await b.page.locator('svg').getAttribute('fill'),
			starred ? 'currentColor' : 'none'
		);
		assert.equal((await b.button.getAttribute('class'))!.includes('text-yellow-400'), starred);
		await b.page.close();
	}
});
