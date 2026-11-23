import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createServer } from 'vite';
import { coreSite, checkLinks } from '$lib/links';
mock.module('$lib/server/postgres', {
	namedExports: {
		query: () => assert.fail('unexpected database read'),
		withTransaction: () => assert.fail('unexpected transaction')
	}
});
const { formUpdate } = await import('$lib/server/member-edit');
const { launchChromium } = await import(`${process.cwd()}/scripts/chromium.ts`);

type RemovalCase = {
	required: boolean;
	emptiedRows: number[];
	remainingSites: string[];
	expectedValid: boolean;
};

for (const c of [
	{ required: true, emptiedRows: [0], remainingSites: ['linkedin'], expectedValid: true },
	{ required: true, emptiedRows: [1], remainingSites: ['github'], expectedValid: true },
	{ required: false, emptiedRows: [0, 1], remainingSites: [], expectedValid: true }
] satisfies RemovalCase[]) {
	test(`R5/R7: no-JavaScript required=${c.required}, clearing rows ${c.emptiedRows} permits this valid remaining answer`, async () => {
		const server = await createServer({
			server: { middlewareMode: true, watch: null, hmr: false },
			appType: 'custom',
			logLevel: 'silent'
		});
		const browser = await launchChromium();
		try {
			const { default: LinksField } = await server.ssrLoadModule(
				'/src/lib/components/LinksField.svelte'
			);
			const { render } = await server.ssrLoadModule('svelte/server');
			const sites = [coreSite('github')!, coreSite('linkedin')!, coreSite('website')!];
			const html = render(LinksField, {
				props: {
					name: 'links',
					label: 'Links',
					sites,
					required: c.required,
					entries: [
						{ site: 'github', handle: 'ada' },
						{ site: 'linkedin', handle: 'ada-l' }
					]
				}
			}).body;
			const page = await browser.newPage({ javaScriptEnabled: false });
			await page.setContent(`<form id="profile">${html}<button>Save</button></form>`);
			for (const i of c.emptiedRows)
				await page.locator('input[name="links:handle"]').nth(i).fill('');
			const result = await page.locator('#profile').evaluate((f: HTMLFormElement) => ({
				valid: f.checkValidity(),
				posted: [...new FormData(f).entries()].map(([k, v]) => [k, String(v)]),
				invalid: [...f.querySelectorAll<HTMLInputElement>('input:invalid')].map((i) => ({
					name: i.name,
					value: i.value,
					required: i.required
				}))
			}));
			const form = new FormData();
			for (const [k, v] of result.posted) form.append(k, v);
			const entries = formUpdate(form).links!.links;
			assert.deepEqual(
				entries.map((e) => e.site),
				c.remainingSites
			);
			assert.equal(checkLinks(entries, sites).ok, true);
			console.log(JSON.stringify({ c, entries, result }));
			assert.equal(
				result.valid,
				c.expectedValid,
				JSON.stringify({ c, entries, invalid: result.invalid })
			);
		} finally {
			await browser.close();
			await server.close();
		}
	});
}
