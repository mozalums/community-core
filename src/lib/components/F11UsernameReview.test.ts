// Mounts UsernameField in Chromium under a fake clock and drives it by typing,
// against a stubbed fetch whose requests stay open until the test answers them:
// the debounce, the cancellation of a superseded check, and each status the
// aria-live line can show are all read from the DOM.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import { compile } from 'svelte/compiler';
import type { Page } from 'playwright-core';
import { launchChromium } from '../../../scripts/chromium';

const component = path.join(import.meta.dirname, 'UsernameField.svelte');
const harness = `<script>
import UsernameField from ${JSON.stringify(component)};
let { initial } = $props();
let error = $state(initial.error ?? '');
window.setUsernameError = (value) => { error = value; };
</script><UsernameField {...initial} {error} />`;

const bundle = await build({
	configFile: false,
	logLevel: 'silent',
	plugins: [
		{
			name: 'username-field-harness',
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

async function mounted(initial: { value?: string; current?: string; error?: string } = {}) {
	const page: Page = await browser.newPage();
	await page.setContent('<!doctype html><html><body></body></html>');
	await page.clock.install();
	await page.addScriptTag({ content: script });
	await page.evaluate(() => {
		const w = window as any;
		// No function here may be bound to a name: tsx wraps named ones in a
		// helper the page does not have.
		w.calls = [];
		w.answers = [];
		w.fetch = (url: string, init: RequestInit) =>
			new Promise((resolve, reject) => {
				w.calls.push({ url, aborted: false });
				const at = w.calls.length - 1;
				w.answers.push((body: unknown, status: number) =>
					resolve(new Response(JSON.stringify(body), { status }))
				);
				init.signal?.addEventListener('abort', () => {
					w.calls[at].aborted = true;
					reject(new DOMException('aborted', 'AbortError'));
				});
			});
	});
	await page.evaluate(
		(p) =>
			(window as any).start({
				endpoint: '/members/usernames',
				name: 'profile_username',
				value: '',
				current: '',
				...p
			}),
		initial
	);
	const input = page.locator('#f-username');
	const live = page.locator('#f-username-status');
	return {
		page,
		type: async (text: string) => {
			await input.focus();
			await page.keyboard.type(text);
		},
		clear: async () => {
			await input.focus();
			await page.keyboard.press('ControlOrMeta+A');
			await page.keyboard.press('Backspace');
		},
		wait: (ms: number) => page.clock.runFor(ms),
		calls: () => page.evaluate(() => (window as any).calls),
		answer: (body: unknown, status = 200) =>
			page.evaluate(([b, s]) => (window as any).answers.at(-1)(b, s), [body, status] as const),
		status: async () => ({
			text: (await live.textContent())?.trim(),
			kind: await live.getAttribute('data-status')
		}),
		live
	};
}


test('F11 review R3: a save failure wins over an availability request still in flight', async () => {
  const f = await mounted();
  try {
    await f.type('grace');
    await f.wait(400);
    await f.page.evaluate(() => (window as any).setUsernameError('that username is taken'));
    assert.equal((await f.status()).text, 'that username is taken');
    await f.answer({ status: 'available', name: 'grace' });
    const actual = await f.status();
    console.log('STATUS_AFTER_SAVE_FAILURE', JSON.stringify(actual));
    assert.equal(actual.text, 'that username is taken');
  } finally {
    await f.page.close();
  }
});

