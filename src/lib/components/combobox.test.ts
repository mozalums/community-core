import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createServer } from 'vite';
import { compile } from 'svelte/compiler';
import { launchChromium } from '../../../scripts/chromium';
import { DIALING_CODES, matchDialingCode } from '../data/field-options';
import {
	comboDismiss,
	comboFiltered,
	comboInit,
	comboKey,
	comboType,
	type ComboState
} from './combobox';

// The keyboard test mounts Combobox.svelte in Chromium and reads the posted value
// from the form itself. The controller tests below pin edge cases a browser run
// would only repeat; the server render proves the no-JS fallback.

const UK = '🇬🇧 +44 United Kingdom';
const US = '🇺🇸 +1 United States';
const options = DIALING_CODES;
const key = (s: ComboState, k: string) => {
	const next = comboKey(s, k, options, matchDialingCode);
	assert.ok(next, `${k} was not handled`);
	return next;
};
const shown = (s: ComboState) => comboFiltered(options, s, matchDialingCode);

const root = path.resolve(import.meta.dirname, '../../..');
const harness = `<script>
import Combobox from './src/lib/components/Combobox.svelte';
import { DIALING_CODES, matchDialingCode } from './src/lib/data/field-options.ts';
</script>
<form onsubmit={(e) => { e.preventDefault(); window.posted = [...new FormData(e.currentTarget).entries()]; }}>
<label for="f-cellCode">Dialing code</label>
<Combobox id="f-cellCode" name="cellCode" value="${US}" options={DIALING_CODES} match={matchDialingCode} />
<button type="submit">Save</button>
</form>`;

/** The component inside a real form, compiled for the browser. */
async function mountedBundle(): Promise<string> {
	const require = createRequire(path.join(root, 'package.json'));
	const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
	const svelte = (code: string, filename: string) =>
		compile(code, { filename, generate: 'client' }).js.code;
	const result = await build({
		stdin: {
			contents:
				"import { mount, flushSync } from 'svelte'; import Harness from 'harness'; mount(Harness, { target: document.body }); flushSync();",
			resolveDir: root
		},
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		conditions: ['browser'],
		plugins: [
			{
				name: 'svelte',
				setup(b: any) {
					b.onResolve({ filter: /^harness$/ }, () => ({ path: 'harness', namespace: 'harness' }));
					b.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
						contents: svelte(harness, path.join(root, 'harness.svelte')),
						resolveDir: root
					}));
					b.onLoad({ filter: /\.svelte$/ }, ({ path: file }: { path: string }) => ({
						contents: svelte(readFileSync(file, 'utf8'), file),
						resolveDir: path.dirname(file)
					}));
				}
			}
		]
	});
	return result.outputFiles[0].text;
}

test('E52 R1/R5: filter, pick and Escape by keyboard, and the posted value follows', async () => {
	const browser = await launchChromium();
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(5000);
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.goto('about:blank');
		await page.addScriptTag({ content: await mountedBundle() });
		const box = page.getByRole('combobox');
		const listbox = page.locator('[role=listbox]');
		const active = () =>
			box.evaluate((el) => {
				const id = el.getAttribute('aria-activedescendant');
				return id ? document.getElementById(id)?.textContent?.trim() : null;
			});
		const focused = () => page.evaluate(() => document.activeElement?.getAttribute('role'));

		await box.focus();
		await box.press('ControlOrMeta+A');
		await box.pressSequentially('uni');
		await assert.doesNotReject(listbox.waitFor({ state: 'visible' }));
		assert.equal(await box.getAttribute('aria-expanded'), 'true');
		assert.deepEqual(
			await page
				.getByRole('option')
				.allTextContents()
				.then((t) => t.map((x) => x.trim())),
			['🇦🇪 +971 United Arab Emirates', UK, US]
		);
		assert.equal(await active(), '🇦🇪 +971 United Arab Emirates');

		await box.press('ArrowDown');
		assert.equal(await active(), UK);
		await box.press('End');
		assert.equal(await active(), US);
		await box.press('Home');
		await box.press('ArrowDown');
		await box.press('Enter');
		assert.equal(await box.inputValue(), UK);
		assert.equal(await box.getAttribute('aria-expanded'), 'false');
		assert.equal(await listbox.isHidden(), true);
		assert.equal(await focused(), 'combobox');

		// A new query abandoned with Escape leaves the pick in place.
		await box.press('ControlOrMeta+A');
		await box.pressSequentially('fra');
		assert.equal(await box.getAttribute('aria-expanded'), 'true');
		assert.ok((await page.getByRole('option').allTextContents()).some((t) => t.includes('France')));
		await box.press('Escape');
		assert.equal(await box.inputValue(), UK);
		assert.equal(await box.getAttribute('aria-expanded'), 'false');
		assert.equal(await focused(), 'combobox');

		// Closed, Enter is the browser's: the form submits what it holds.
		await box.press('Enter');
		assert.deepEqual(await page.evaluate(() => (window as unknown as { posted: unknown }).posted), [
			['cellCode', UK]
		]);
		assert.deepEqual(errors, []);
	} finally {
		await browser.close();
	}
});

test('E52 R1: Down and Up open the full list on the committed value', () => {
	let s = key(comboInit(UK), 'ArrowDown');
	assert.equal(s.open, true);
	assert.equal(shown(s).length, options.length);
	assert.equal(shown(s)[s.active], UK);
	s = key(s, 'ArrowUp');
	assert.equal(s.active, options.indexOf(UK) - 1);
	assert.equal(key(comboInit(''), 'ArrowUp').active, options.length - 1);
});

test('E52 R3: a half-typed query never posts; a cleared box clears the value', () => {
	let s = comboType(comboInit(UK), 'zzz', options, matchDialingCode);
	assert.deepEqual(shown(s), []);
	s = key(s, 'Enter');
	assert.equal(s.value, UK);
	s = comboDismiss(comboType(s, '', options, matchDialingCode));
	assert.equal(s.value, '');
});

test('E52 R1/R3: the component posts its state through a hidden input under the field name', () => {
	const src = readFileSync(new URL('./Combobox.svelte', import.meta.url), 'utf8');
	assert.match(src, /<input type="hidden" \{name\} value=\{s\.value\} \/>/);
	assert.match(src, /role="combobox"/);
	for (const attr of ['aria-expanded', 'aria-controls', 'aria-activedescendant'])
		assert.match(src, new RegExp(`${attr}=`), attr);
	assert.match(src, /role="listbox"/);
	assert.match(src, /role="option"/);
	assert.match(src, /comboKey\(s, e\.key, options, match\)/);
	// The visible text box carries no name, so it never posts.
	const box = src.slice(src.indexOf('<input\n\t\t\t{id}'), src.indexOf('{onkeydown}'));
	assert.match(box, /role="combobox"/);
	assert.doesNotMatch(box, /\{name\}|name=/);
});

test('E52 R3: rendered without JavaScript it is a native select keeping an off-list value', async () => {
	const server = await createServer({
		server: { middlewareMode: true, watch: null, hmr: false },
		appType: 'custom'
	});
	try {
		const { default: Combobox } = await server.ssrLoadModule('/src/lib/components/Combobox.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');
		const body: string = render(Combobox, {
			props: { id: 'f-cellCode', name: 'cellCode', options: ['+999', ...options], value: '+999' }
		}).body;
		assert.match(body, /<select[^>]*name="cellCode"/);
		assert.doesNotMatch(body, /role="combobox"/);
		const selected = [...body.matchAll(/<option[^>]*value="([^"]*)"[^>]*\sselected/g)].map(
			(m) => m[1]
		);
		assert.deepEqual(selected, ['+999']);
		assert.ok(body.includes(`<option value="${UK}">${UK}</option>`), 'stored order on screen');
	} finally {
		await server.close();
	}
});

test('E52 R1: the profile editor mounts the combobox for the dialling-code list', () => {
	const page = readFileSync(
		new URL('../../routes/group/[slug]/members/[id]/edit/+page.svelte', import.meta.url),
		'utf8'
	);
	assert.match(page, /import Combobox from '\$lib\/components\/Combobox\.svelte'/);
	assert.match(page, /\['dialingCodes', matchDialingCode\]/);
	assert.match(page, /<Combobox\b[\s\S]*?name=\{f\.name\}[\s\S]*?withCurrent\(/);
});
