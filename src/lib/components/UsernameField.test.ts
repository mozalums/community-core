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
</script><UsernameField {...initial} />`;

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
	// install() alone lets time keep flowing, so a loaded machine can run the
	// debounce out while a test is still typing; paused, only runFor moves it.
	await page.clock.pauseAt(Date.now() + 60_000);
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

test('F11 R5: the check waits for a 400ms pause, then asks once for what was typed', async () => {
	const f = await mounted();
	assert.equal(await f.live.getAttribute('aria-live'), 'polite');
	await f.type('Ada');
	await f.wait(399);
	assert.deepEqual(await f.calls(), [], 'asked before the pause ended');
	await f.wait(1);
	assert.deepEqual(await f.calls(), [{ url: '/members/usernames?name=Ada', aborted: false }]);
	await f.page.close();
});

test('F11 R5: a keystroke while a check is open cancels it and only the newer answer shows', async () => {
	const f = await mounted();
	await f.type('ada');
	await f.wait(400);
	await f.type('-l');
	assert.deepEqual(await f.calls(), [{ url: '/members/usernames?name=ada', aborted: true }]);
	await f.wait(400);
	await f.answer({ status: 'available', name: 'ada-l' });
	assert.deepEqual(await f.status(), { text: 'ada-l is available.', kind: 'available' });
	assert.equal((await f.calls()).length, 2);
	await f.page.close();
});

test('F11 R5: each answer from the endpoint shows as its own status', async () => {
	const cases: [unknown, string, string][] = [
		[{ status: 'available', name: 'grace' }, 'grace is available.', 'available'],
		[{ status: 'taken', name: 'grace' }, 'grace is taken.', 'taken'],
		[
			{ status: 'invalid', rule: 'length', message: 'use 3 to 30 characters' },
			'Not allowed: use 3 to 30 characters.',
			'invalid'
		],
		[
			{ status: 'reserved', message: 'that name is reserved for the site' },
			'grace is reserved.',
			'reserved'
		],
		[{ status: 'yours', name: 'grace' }, 'grace is already yours.', 'yours']
	];
	for (const [body, text, kind] of cases) {
		const f = await mounted();
		await f.type('grace');
		await f.wait(400);
		await f.answer(body);
		assert.deepEqual(await f.status(), { text, kind });
		await f.page.close();
	}
});

test('F11 R5: clearing a stored username says saving removes it, and asks nothing', async () => {
	const f = await mounted({ value: 'ada-old', current: 'ada-old' });
	await f.clear();
	await f.wait(1000);
	assert.deepEqual(await f.calls(), []);
	const s = await f.status();
	assert.equal(s.kind, 'clearing');
	assert.match(s.text ?? '', /removes ada-old/);
	await f.page.close();
});

test('F11 R3: a save refused as taken shows in the same live line', async () => {
	const f = await mounted({ value: 'grace', current: '', error: 'that username is taken' });
	assert.deepEqual(await f.status(), { text: 'that username is taken', kind: 'error' });
	await f.page.close();
});
