import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mock, test } from 'node:test';
import { createServer } from 'vite';
import {
	HISTORICAL_CONTROL_KEYS,
	HISTORICAL_KEY_FIELDS,
	fieldSchemaWith
} from '$lib/server/field-schema-fake';

// The profile editor's control kind, option list and requiredness come from
// what the skin declares for a field, never from how its key is spelled.

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(HISTORICAL_KEY_FIELDS) });
const unexpected = () => {
	throw new Error('unexpected database access');
};
mock.module('$lib/server/postgres', {
	namedExports: { query: unexpected, withTransaction: unexpected, pgPool: unexpected }
});

const { readEditFields, formUpdate, formEcho, profilePatch } =
	await import('$lib/server/member-edit');
const { validatePatch, computeDelta, deriveColumns } =
	await import('$lib/server/member-write-core');

const MEMBER = {
	name: 'Nomi Vance',
	city: null,
	email: 'nomi@example.org',
	identSubject: 'email:nomi@example.org',
	data: { startYear: 'Nomi Vance', homeland: 'Japan', settlement: 'Tokyo', joined: '2001' },
	privateData: { prefix: '+81', shirt: 'M' }
} as never;

const store = <T>(value: T) => ({
	subscribe(fn: (v: T) => void) {
		fn(value);
		return () => {};
	}
});

async function renderEditor(form: unknown = null): Promise<string> {
	const server = await createServer({
		server: { middlewareMode: true, watch: null, hmr: false },
		appType: 'custom'
	});
	try {
		const { default: Page } = await server.ssrLoadModule(
			'/src/routes/group/[slug]/members/[id]/edit/+page.svelte'
		);
		const { render } = await server.ssrLoadModule('svelte/server');
		const data = {
			group: { slug: 'example', name: 'Example Community' },
			editName: 'Nomi Vance',
			fields: readEditFields(MEMBER),
			affiliations: {
				options: [],
				checks: {},
				other: '',
				publicProfile: false,
				asked: false,
				hasOther: false,
				hasPublicProfile: false
			}
		};
		const context = new Map([
			[
				'__svelte__',
				{
					page: store({
						url: new URL('http://localhost/group/example/members/id/edit'),
						params: { id: 'id' }
					}),
					navigating: store(null),
					updated: store(false)
				}
			]
		]);
		return render(Page, { props: { data, form }, context }).body;
	} finally {
		await server.close();
	}
}

type Control = { tag: string; required: boolean; html: string };
function controlOf(body: string, key: string): Control {
	const open = body.match(new RegExp(`<(input|select|textarea)\\b[^>]*\\bname="${key}"[^>]*>`));
	assert.ok(open, `no control named ${key}`);
	const from = body.indexOf(open[0]);
	const html =
		open[1] === 'input' ? open[0] : body.slice(from, body.indexOf(`</${open[1]}>`, from));
	return { tag: open[1], required: /\srequired(?:[\s=>]|$)/.test(open[0]), html };
}
const optionsOf = (c: Control) =>
	[...c.html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
const selectedOf = (c: Control) =>
	[...c.html.matchAll(/<option[^>]*value="([^"]*)"[^>]*\sselected/g)].map((m) => m[1]);

test('R6: a key the editor once special-cased, on a field that declares nothing, is an optional text input', async () => {
	const body = await renderEditor();
	for (const key of HISTORICAL_CONTROL_KEYS) {
		const c = controlOf(body, key);
		assert.deepEqual({ tag: c.tag, required: c.required }, { tag: 'input', required: false }, key);
	}
	// And no label for one of them carries the required marker.
	for (const key of HISTORICAL_CONTROL_KEYS) {
		const label = body.match(new RegExp(`<label[^>]*for="f-${key}"[^>]*>([\\s\\S]*?)</label>`));
		assert.ok(label, key);
		assert.doesNotMatch(label[1], /\*/, key);
	}
});

test('R6: an option list and requiredness follow the skin’s declaration under any key', async () => {
	const body = await renderEditor();
	const kinds = Object.fromEntries(
		[
			'homeland',
			'settlement',
			'joined',
			'shirt',
			'prefix',
			'motto',
			'story',
			'about',
			'pager',
			'quiet'
		].map((key) => {
			const c = controlOf(body, key);
			return [key, `${c.tag}${c.required ? ' required' : ''}`];
		})
	);
	assert.deepEqual(kinds, {
		homeland: 'select required',
		settlement: 'select',
		joined: 'select required',
		shirt: 'select',
		prefix: 'select',
		motto: 'input required',
		story: 'textarea required',
		about: 'textarea required',
		pager: 'input required',
		quiet: 'input'
	});
	assert.ok(optionsOf(controlOf(body, 'homeland')).includes('Japan'));
	// The city list is the chosen country's, found by declaration, not by a
	// field keyed "country" (which here is an unrelated empty text field).
	const cities = optionsOf(controlOf(body, 'settlement'));
	assert.ok(cities.includes('Tokyo') && cities.length > 2, cities.join());
	assert.ok(optionsOf(controlOf(body, 'joined')).includes('1994'));
	assert.deepEqual(selectedOf(controlOf(body, 'joined')), ['2001']);
	assert.ok(optionsOf(controlOf(body, 'shirt')).includes('XXL'));
	assert.deepEqual(selectedOf(controlOf(body, 'prefix')), ['+81']);
	// Required fields are marked in both cards and on the bio.
	for (const key of ['homeland', 'motto', 'pager']) {
		const label = body.match(new RegExp(`<label[^>]*for="f-${key}"[^>]*>([\\s\\S]*?)</label>`));
		assert.match(label?.[1] ?? '', /\*/, key);
	}
});

test('R6: a refused save refills the country and city selects from what was posted', async () => {
	const form = new FormData();
	form.set('homeland', 'France');
	form.set('settlement', 'Paris');
	form.set('country', 'typed freely');
	const body = await renderEditor({ error: 'refused', values: formEcho(formUpdate(form)) });
	assert.ok(optionsOf(controlOf(body, 'settlement')).includes('Paris'));
	assert.match(controlOf(body, 'country').html, /value="typed freely"/);
});

test('R6: free text under a historical key, and an empty optional answer, save and read back', () => {
	const form = new FormData();
	form.set('startYear', 'Nomi Vale');
	form.set('endYear', 'not a year at all');
	form.set('cellCode', '');
	form.set('firstName', '');
	const patch = profilePatch(formUpdate(form));
	validatePatch(patch, { writer: 'form', mayWritePrivate: true });
	const row = MEMBER as { data: Record<string, unknown>; email: string };
	const { next, changed } = computeDelta(row.data, patch);
	const saved = {
		...(MEMBER as object),
		...deriveColumns(next, changed, MEMBER),
		data: next
	} as never;
	const read = Object.fromEntries(readEditFields(saved).map((f) => [f.name, f.value]));
	assert.equal((saved as { name: string }).name, 'Nomi Vale');
	assert.equal((saved as { email: string }).email, row.email);
	assert.equal(read.startYear, 'Nomi Vale');
	assert.equal(read.endYear, 'not a year at all');
	assert.equal(read.cellCode, '');
	assert.equal(read.firstName, '');
});

test('R6: the editor reads no field key to choose a control', () => {
	const src = readFileSync(
		new URL('../../../routes/group/[slug]/members/[id]/edit/+page.svelte', import.meta.url),
		'utf8'
	);
	// A key reaches the markup as the control's name, its id and its lookup
	// into posted values, and nowhere as a condition.
	assert.doesNotMatch(src, /\.name\s*[!=]==?\s*['"`]/, 'a control is chosen by a literal key');
	assert.doesNotMatch(src, /\.(has|get)\(\s*\w+\.name\s*\)/, 'a table is looked up by field key');
	assert.doesNotMatch(src, /\b(REQUIRED|SELECT_LISTS|SELECT_LABELS)\b/);
});
