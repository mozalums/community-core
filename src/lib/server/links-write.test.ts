// A links field through the profile form's controls and the write path, on the default skin, whose links field is keyed `links`.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

mock.module('$lib/server/postgres', {
	namedExports: {
		query: async () => assert.fail('read the database'),
		withTransaction: async () => assert.fail('opened a transaction')
	}
});
const { computeDelta, encodeValues, validatePatch, MemberWriteError } =
	await import('./member-write-core');
const { formUpdate, linkRows, linksEcho, profilePatch, readEditFields } =
	await import('./member-edit');

const form = (pairs: [string, string][]) => {
	const f = new FormData();
	for (const [k, v] of pairs) f.append(k, v);
	return f;
};
const save = { writer: 'form' as const, mayWritePrivate: true };

test('the form posts a site and a value per row, in order, and an always-present marker', () => {
	const u = formUpdate(
		form([
			['name', 'Ada'],
			['links:links', ''],
			['links:site', 'github'],
			['links:handle', ' https://github.com/ada '],
			['links:site', 'linkedin'],
			['links:handle', 'ada-l'],
			['links:site', 'mastodon'],
			['links:handle', '']
		])
	);
	assert.deepEqual(
		{ ...u.links },
		{
			links: [
				{ site: 'github', handle: 'https://github.com/ada' },
				{ site: 'linkedin', handle: 'ada-l' }
			]
		}
	);
	assert.deepEqual({ ...u.updates }, { name: 'Ada' });
	assert.deepEqual(linksEcho(u), { ...u.links });
	// The marker alone: every row was removed, and the field is emptied.
	assert.deepEqual(profilePatch(formUpdate(form([['links:links', '']]))).links, []);
	// A form that never showed the field leaves it alone.
	assert.ok(!('links' in profilePatch(formUpdate(form([['name', 'Ada']])))));
});

test('a row with a value and no site reaches the check and is refused', () => {
	assert.deepEqual(linkRows(['', 'github'], ['ada', '']), [{ site: '', handle: 'ada' }]);
	assert.throws(
		() => validatePatch({ links: [{ site: '', handle: 'ada' }] }, save),
		(e: unknown) => e instanceof MemberWriteError && e.message === 'choose a site for "ada"'
	);
});

test('the server stores handles, never URLs, and refuses with the site and the form', () => {
	const out = validatePatch(
		{
			links: [
				{ site: 'linkedin', handle: 'https://www.linkedin.com/in/ravinald/?trk=x' },
				{ site: 'mastodon', handle: '@ravi@Mastodon.social' }
			]
		},
		save
	);
	assert.deepEqual(out.links, [
		{ site: 'linkedin', handle: 'ravinald' },
		{ site: 'mastodon', handle: 'ravi@mastodon.social' }
	]);
	assert.throws(
		() =>
			validatePatch({ links: [{ site: 'linkedin', handle: 'https://evil.example/in/x' }] }, save),
		(e: unknown) =>
			e instanceof MemberWriteError &&
			e.status === 400 &&
			e.field === 'links' &&
			e.message === 'LinkedIn: the part after linkedin.com/in/'
	);
	assert.throws(
		() =>
			validatePatch(
				{
					links: [
						{ site: 'github', handle: 'a' },
						{ site: 'github', handle: 'b' }
					]
				},
				save
			),
		/GitHub: only one link per site/
	);
	assert.throws(
		() => validatePatch({ links: [{ site: 'myspace', handle: 'a' }] }, save),
		/not a site/
	);
});

test('an entry for a site the skin no longer offers survives a save that cannot show it', () => {
	const current = {
		links: [
			{ site: 'myspace', handle: 'ada' },
			{ site: 'github', handle: 'old' }
		]
	};
	const out = validatePatch({ links: [{ site: 'github', handle: 'ada' }] }, { ...save, current });
	assert.deepEqual(out.links, [
		{ site: 'github', handle: 'ada' },
		{ site: 'myspace', handle: 'ada' }
	]);
	// Removing every row offered leaves the retired one.
	assert.deepEqual(validatePatch({ links: [] }, { ...save, current }).links, [
		{ site: 'myspace', handle: 'ada' }
	]);
	// A new handle for a site no longer offered is new input, and refused.
	assert.throws(
		() => validatePatch({ links: [{ site: 'myspace', handle: 'bea' }] }, { ...save, current }),
		/not a site this community offers/
	);
});

test('the stored list is ordered, empty removes the key, and an unchanged list is no change', () => {
	const list = [
		{ site: 'github', handle: 'ada' },
		{ site: 'linkedin', handle: 'ada' }
	];
	assert.deepEqual(computeDelta({}, { links: list }), {
		next: { links: list },
		changed: ['links']
	});
	assert.deepEqual(computeDelta({ links: list }, { links: [...list] }).changed, []);
	assert.deepEqual(computeDelta({ links: list }, { links: [] }), { next: {}, changed: ['links'] });
	assert.deepEqual(encodeValues({ links: list, name: 'Ada' }), { links: list, name: 'Ada' });
	assert.throws(() => validatePatch({ links: 'github:ada' }, save), /wrong type/);
	assert.throws(() => validatePatch({ links: true }, save), /wrong type/);
	assert.throws(() => validatePatch({ name: [] }, save), /wrong type/);
});

test("the edit form reads a member's entries with the sites the field offers", () => {
	const [f] = readEditFields({
		data: { links: [{ site: 'github', handle: 'ada' }] },
		privateData: {}
	} as never).filter((x) => x.name === 'links');
	assert.equal(f.value, '');
	assert.deepEqual(f.links!.entries, [{ site: 'github', handle: 'ada' }]);
	assert.deepEqual(
		f.links!.sites.map((s) => s.id),
		['linkedin', 'github', 'mastodon', 'bluesky', 'website', 'codeberg']
	);
});
