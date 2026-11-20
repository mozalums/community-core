import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// The profile renders what the field schema says the caller may see, in
// schema order. There is no list of fields on the page to keep in step with
// the schema, so these assert against the schema itself. The default skin has
// no handle, affiliation or retired field; what the page does with those is in
// src/lib/skin/every-role/profile-page.test.ts.

const ID = '00000000-0000-4000-8000-0000000000aa';
const MEMBER = {
	id: ID,
	groupId: 'g',
	email: 'ada@example.org',
	identSubject: null,
	name: 'Ada Byron',
	city: 'London',
	linkedin: null,
	status: 'active',
	data: {
		name: 'Ada Byron',
		bio: 'Wrote the first program.',
		country: 'UK',
		city: 'London'
	},
	privateData: {
		phone: '+44 20 7946 0000',
		'x.Badge No': '0042'
	}
};

mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => ({ id: 'g', slug: 'example', name: 'Example' }) }
});
mock.module('$lib/server/members', {
	namedExports: {
		getMemberById: async () => structuredClone(MEMBER),
		canEditMember: () => false
	}
});
mock.module('$lib/server/avatars', { namedExports: { avatarIdFor: async () => null } });
mock.module('$lib/server/gravatar', { namedExports: { gravatarHash: () => 'h' } });

const { load } = await import('./+page.server');
const { DEFAULT_FIELD_SCHEMA } = await import('$lib/server/field-schema');

type Loaded = {
	profile: { handle: string | null; bio: string | null; details: { key: string; label: string }[] };
	privateFields: { key: string; label: string; value: string | null }[] | null;
};
const view = async (isGroupAdmin: boolean) =>
	(await load({
		params: { slug: 'example', id: ID },
		locals: { user: { subject: 's', email: 'viewer@example.org' } },
		parent: async () => ({ isGroupAdmin })
	} as never)) as Loaded;

const order = new Map(DEFAULT_FIELD_SCHEMA.map((f) => [f.key, f.order]));

test('R2: a member sees the members-visible fields, in schema order, and no private value', async () => {
	const v = await view(false);
	const keys = v.profile.details.map((d) => d.key);
	// No affiliation field, so no "Associated with" heading either.
	assert.deepEqual(keys, ['country', 'city']);
	const ranked = keys.filter((k) => order.has(k)).map((k) => order.get(k)!);
	assert.deepEqual(
		ranked,
		[...ranked].sort((a, b) => a - b)
	);
	assert.equal(v.profile.handle, null);
	assert.equal(v.profile.bio, 'Wrote the first program.');
	assert.equal(v.privateFields, null);
	const payload = JSON.stringify(v);
	for (const secret of ['7946', '0042', 'Badge No']) {
		assert.ok(!payload.includes(secret), `"${secret}" reached a non-admin`);
	}
});

test('R5: an admin sees the private fields, x.* columns included, and never a retired one', async () => {
	const v = await view(true);
	const priv = v.privateFields ?? [];
	assert.deepEqual(
		priv.find((p) => p.key === 'x.Badge No'),
		{ key: 'x.Badge No', label: 'Badge No', value: '0042' }
	);
	assert.deepEqual(
		priv.map((p) => p.key),
		['phone', 'x.Badge No']
	);
	assert.equal(priv.find((p) => p.key === 'phone')?.value, '+44 20 7946 0000');
	assert.equal(priv.at(-1)?.key, 'x.Badge No', 'x.* fields sort after the schema');
});
