import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createServer } from 'vite';
const { launchChromium } = await import(`${process.cwd()}/scripts/chromium.ts`);
import type { SkinField } from '$lib/skin/schema';
import { fieldSchemaWith } from '$lib/server/field-schema-fake';

type FieldCase = { type: 'text' | 'links'; required: boolean; expectedValid: boolean };
const PROFILE_FIELDS: SkinField[] = [
	{ key: 'name', label: 'Name', type: 'text', role: 'name', column: 'name', visibility: 'members' },
	{
		key: 'profiles',
		label: 'Profiles',
		type: 'links',
		sites: ['github'],
		required: true,
		visibility: 'members'
	}
];
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(PROFILE_FIELDS) });
mock.module('$lib/server/postgres', {
	namedExports: {
		query: () => assert.fail('unexpected database read'),
		withTransaction: () => assert.fail('unexpected transaction')
	}
});
const { readEditFields } = await import('$lib/server/member-edit');
const store = (value: unknown) => ({
	subscribe(fn: (v: unknown) => void) {
		fn(value);
		return () => {};
	}
});

for (const c of [
	{ type: 'text', required: true, expectedValid: false },
	{ type: 'links', required: false, expectedValid: true },
	{ type: 'links', required: true, expectedValid: false }
] satisfies FieldCase[]) {
	test(`the edit form honors required=${c.required} on an empty ${c.type} field`, async () => {
		const server = await createServer({
			server: { middlewareMode: true, watch: null, hmr: false },
			appType: 'custom',
			logLevel: 'silent'
		});
		const browser = await launchChromium();
		try {
			const { default: Page } = await server.ssrLoadModule(
				'/src/routes/group/[slug]/members/[id]/edit/+page.svelte'
			);
			const { render } = await server.ssrLoadModule('svelte/server');
			const edit = readEditFields({
				name: 'Ada',
				city: null,
				email: 'ada@example.org',
				data: { name: 'Ada' },
				privateData: {}
			} as never);
			const f = edit.find((f) => f.name === 'profiles')!;
			f.required = c.required;
			if (c.type === 'text') delete f.links;
			const html = render(Page, {
				props: {
					form: null,
					data: {
						group: { slug: 'example', name: 'Example' },
						ref: 'ada',
						editName: 'Ada',
						fields: edit,
						affiliations: {
							options: [],
							checks: {},
							other: '',
							publicProfile: false,
							asked: false,
							hasOther: false,
							hasPublicProfile: false
						}
					}
				},
				context: new Map([
					[
						'__svelte__',
						{
							page: store({
								url: new URL('https://example.org/members/ada/edit'),
								params: { id: 'ada' }
							}),
							navigating: store(null),
							updated: store(false)
						}
					]
				])
			}).body;
			const page = await browser.newPage();
			await page.setContent(html);
			const result = await page.locator('form[action="?/save"]').evaluate((f: HTMLFormElement) => ({
				valid: f.checkValidity(),
				controls: [...f.elements]
					.filter((x) => 'name' in x && String(x.name).startsWith('profiles'))
					.map((x) => ({
						name: (x as HTMLInputElement).name,
						required: (x as HTMLInputElement).required,
						value: (x as HTMLInputElement).value
					}))
			}));
			console.log(JSON.stringify({ c, result }));
			assert.equal(result.valid, c.expectedValid, JSON.stringify(result));
		} finally {
			await browser.close();
			await server.close();
		}
	});
}

const { build } = await import('vite');
const { compile } = await import('svelte/compiler');
const { coreSite } = await import('$lib/links');
const component = `${process.cwd()}/src/lib/components/LinksField.svelte`;
const harness = `<script>import LinksField from ${JSON.stringify(component)};let { initial } = $props();</script><form id="links-form"><LinksField {...initial}/></form>`;
const bundle = await build({
	configFile: false,
	logLevel: 'silent',
	plugins: [
		{
			name: 'required-links',
			resolveId: (id: string) => (id === 'entry' || id === 'harness' ? id : undefined),
			load(id: string) {
				if (id === 'entry')
					return `import {mount,flushSync} from 'svelte';import Harness from 'harness';window.start=(initial)=>{mount(Harness,{target:document.body,props:{initial}});flushSync();};`;
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
	(p) => p.type === 'chunk'
)!.code;
for (const saved of [false, true]) {
	test(`the hydrated required links field refuses ${saved ? 'removing its last saved row' : 'an empty answer'}`, async () => {
		const browser = await launchChromium();
		try {
			const page = await browser.newPage();
			await page.setContent('<!doctype html><html><body></body></html>');
			await page.addScriptTag({ content: script });
			await page.evaluate((initial: unknown) => (window as any).start(initial), {
				name: 'profiles',
				label: 'Profiles',
				required: true,
				sites: [coreSite('github')!, coreSite('linkedin')!],
				entries: saved ? [{ site: 'github', handle: 'ada' }] : []
			});
			const valid = () =>
				page.locator('#links-form').evaluate((f: HTMLFormElement) => f.checkValidity());
			if (saved) {
				assert.equal(
					await valid(),
					true,
					'a saved link satisfies required without adding another row'
				);
				await page.getByRole('button', { name: 'Remove GitHub link' }).click();
			}
			console.log(JSON.stringify({ saved, valid: await valid() }));
			assert.equal(await valid(), false, 'a required links field must refuse zero rows');
		} finally {
			await browser.close();
		}
	});
}

test('the profile save refuses an empty required links field and accepts one link', async () => {
	const { validatePatch } = await import('$lib/server/member-write-core');
	const opts = { writer: 'form' as const, mayWritePrivate: true };
	assert.throws(() => validatePatch({ profiles: [] }, opts), /add at least one link/);
	assert.deepEqual(
		validatePatch({ profiles: [{ site: 'github', handle: 'ada' }] }, opts).profiles,
		[{ site: 'github', handle: 'ada' }]
	);
});
