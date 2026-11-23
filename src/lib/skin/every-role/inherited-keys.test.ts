import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createServer } from 'vite';
import { INHERITED_KEY_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

const KEYS = INHERITED_KEY_FIELDS.map((f) => f.key);

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(INHERITED_KEY_FIELDS) });
const unexpected = () => {
	throw new Error('unexpected database access');
};
mock.module('$lib/server/postgres', {
	namedExports: { query: unexpected, withTransaction: unexpected, pgPool: unexpected }
});

const { promotedColumns, ownValue } = await import('$lib/server/field-schema');
const { readEditFields, readAffiliations, formUpdate, formEcho, choiceEcho, profilePatch } =
	await import('$lib/server/member-edit');
const { validatePatch, computeDelta, deriveColumns, auditDiff, encodeValues } =
	await import('$lib/server/member-write-core');
const { memberCsv } = await import('$lib/server/member-export');
const { storedValue } = await import('$lib/server/import-core');
const { diffFields } = await import('$lib/server/audit-core');

const EMPTY = {
	name: null,
	city: null,
	email: 'nomi@example.org',
	identSubject: null,
	data: {},
	privateData: {}
} as never;

test('the fixture gives a field to every inherited name the key pattern accepts', () => {
	const inherited = Object.getOwnPropertyNames(Object.prototype).filter((n) =>
		/^[a-z][A-Za-z0-9]*$/.test(n)
	);
	assert.deepEqual([...KEYS].sort(), inherited.sort());
});

test('a member who stored nothing reads empty under every inherited key', () => {
	for (const f of readEditFields(EMPTY)) assert.equal(f.value, '', f.name);
	assert.deepEqual(readAffiliations(EMPTY), {
		checks: { valueOf: false },
		other: '',
		publicProfile: false
	});
	assert.deepEqual(promotedColumns({}), { email: null, name: null, city: null });
	for (const key of KEYS) {
		assert.equal(ownValue({}, key), undefined, key);
		assert.equal(
			storedValue({ id: 'm', email: 'e', status: 'active', data: {}, privateData: {} }, key),
			undefined,
			key
		);
	}
	const csv = memberCsv(
		[{ email: 'nomi@example.org', status: 'active', data: {}, privateData: {} }],
		{ includePrivate: true, includeRemoved: false }
	);
	assert.doesNotMatch(csv, /function|native code/);
});

test('saving the untouched form of an empty member changes nothing', () => {
	const u = formUpdate(new FormData());
	const patch = profilePatch(u);
	validatePatch(patch, { writer: 'form', mayWritePrivate: true });
	const { next, changed } = computeDelta({}, patch);
	assert.deepEqual(changed, []);
	assert.deepEqual(Object.keys(next), []);
	assert.deepEqual(formEcho(u), {});
	assert.deepEqual(choiceEcho(u), { checks: { valueOf: false }, other: '', publicProfile: false });
});

test('a value posted under every inherited key is stored, derived, audited and read back', () => {
	const form = new FormData();
	form.set('toString', 'Nomi Vance');
	form.set('toLocaleString', 'Leeds');
	form.set('propertyIsEnumerable', 'https://example.org/nomi');
	form.set('isPrototypeOf', '+44 20 7946 0000');
	form.set('aff_valueOf', 'on');
	form.set('otherAffiliations', 'Volunteer');
	form.set('publicProfile', 'on');
	const u = formUpdate(form);
	const patch = profilePatch(u);
	validatePatch(patch, { writer: 'form', mayWritePrivate: true });
	const want = {
		toString: 'Nomi Vance',
		toLocaleString: 'Leeds',
		propertyIsEnumerable: 'https://example.org/nomi',
		isPrototypeOf: '+44 20 7946 0000',
		valueOf: 'TRUE',
		hasOwnProperty: 'Volunteer',
		constructor: 'TRUE'
	};
	const { next, changed } = computeDelta({}, patch);
	assert.deepEqual(Object.fromEntries(Object.entries(next)), want);
	assert.deepEqual([...changed].sort(), [...KEYS].sort());
	assert.deepEqual(Object.fromEntries(Object.entries(encodeValues(patch))), want);
	assert.deepEqual(deriveColumns(next, changed), {
		name: 'Nomi Vance',
		city: 'Leeds'
	});

	const audit = auditDiff(changed, {}, next, false);
	assert.deepEqual(audit.redacted, ['isPrototypeOf']);
	for (const key of KEYS) {
		assert.ok(Object.hasOwn(audit.before, key), key);
		assert.doesNotMatch(String(audit.before[key]), /function/, key);
	}
	// A key only one side holds is a change from nothing, never from a function.
	assert.deepEqual(diffFields([{ name: 'toString' }], {}, { toString: 'x' }, false), {
		before: { toString: '' },
		after: { toString: 'x' },
		redacted: []
	});
	assert.deepEqual(diffFields([{ name: 'toString' }], { toString: 'x' }, {}, false), {
		before: {},
		after: {},
		redacted: []
	});

	const saved = { ...(EMPTY as object), data: next, privateData: {} } as never;
	assert.deepEqual(Object.fromEntries(readEditFields(saved).map((f) => [f.name, f.value])), {
		toString: 'Nomi Vance',
		isPrototypeOf: '+44 20 7946 0000',
		propertyIsEnumerable: 'https://example.org/nomi',
		toLocaleString: 'Leeds'
	});
	assert.deepEqual(readAffiliations(saved), {
		checks: { valueOf: true },
		other: 'Volunteer',
		publicProfile: true
	});
	// Unticking on the next save is a change, and stored as an answer.
	const cleared = computeDelta(next, profilePatch(formUpdate(new FormData())));
	assert.equal(cleared.next.constructor, 'FALSE');
	assert.equal(cleared.next.valueOf, 'FALSE');
});

const store = <T>(value: T) => ({
	subscribe(fn: (v: T) => void) {
		fn(value);
		return () => {};
	}
});

test('the editor renders an empty member, and a refused save, with every inherited key as a control', async () => {
	const server = await createServer({
		server: { middlewareMode: true, watch: null, hmr: false },
		appType: 'custom'
	});
	try {
		const { default: Page } = await server.ssrLoadModule(
			'/src/routes/group/[slug]/members/[id]/edit/+page.svelte'
		);
		const { render } = await server.ssrLoadModule('svelte/server');
		const context = () =>
			new Map([
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
		const data = {
			group: { slug: 'example', name: 'Example Community' },
			editName: 'Nomi',
			fields: readEditFields(EMPTY),
			affiliations: {
				options: [{ key: 'valueOf', label: 'Staff' }],
				asked: true,
				hasOther: true,
				hasPublicProfile: true,
				...readAffiliations(EMPTY)
			}
		};
		// A refused save echoes only what was posted; here, nothing.
		const u = formUpdate(new FormData());
		const refused = { error: 'refused', values: formEcho(u), choices: choiceEcho(u) };
		for (const form of [null, refused]) {
			const { body } = render(Page, { props: { data, form }, context: context() });
			for (const key of ['toString', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString']) {
				assert.match(body, new RegExp(`<input[^>]*name="${key}"`), key);
			}
			assert.match(body, /name="aff_valueOf"/);
			assert.doesNotMatch(body, /native code|function /);
			assert.doesNotMatch(body, /<input[^>]*type="checkbox"[^>]*\schecked/);
			assert.doesNotMatch(body, /<select/);
		}
	} finally {
		await server.close();
	}
});
