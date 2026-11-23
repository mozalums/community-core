import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// The profile page where it reads a role the default skin has no field for:
// handle, the affiliations folded into "Associated with", the email-role
// field, and a retired field that is kept and never shown. The rest is in
// src/routes/group/[slug]/members/[id]/page.server.test.ts.

const ID = '00000000-0000-4000-8000-0000000000aa';
const MEMBER = {
	id: ID,
	groupId: 'g',
	email: 'ada@example.org',
	identSubject: null,
	name: 'Ada Byron',
	city: 'London',
	status: 'active',
	data: {
		givenName: 'Ada',
		familyName: 'Byron',
		handle: 'enchantress',
		bio: 'Wrote the first program.',
		interests: 'Poetry, Horses',
		country: 'UK',
		startYear: '2008',
		staff: 'TRUE',
		volunteer: 'FALSE',
		otherAffiliations: 'Analytical Engine',
		publicProfile: 'TRUE',
		website: 'https://example.org/ada'
	},
	privateData: {
		email: 'ada@example.org',
		phone: '+44 20 7946 0000',
		legacyAccess: 'admin',
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
mock.module('$lib/server/stars', { namedExports: { isStarred: async () => false } });

const { load } = await import('../../../routes/group/[slug]/members/[id]/+page.server');
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
	assert.deepEqual(keys, ['associations', 'country', 'city', 'startYear', 'interests', 'website']);
	const ranked = keys.filter((k) => order.has(k)).map((k) => order.get(k)!);
	assert.deepEqual(
		ranked,
		[...ranked].sort((a, b) => a - b)
	);
	assert.equal(v.profile.handle, 'enchantress');
	assert.equal(v.profile.bio, 'Wrote the first program.');
	assert.equal(v.privateFields, null);
	const payload = JSON.stringify(v);
	for (const secret of ['7946', '0042', 'Badge No', 'admin']) {
		assert.ok(!payload.includes(secret), `"${secret}" reached a non-admin`);
	}
});

test('R2: "Associated with" is built from the affiliation-role fields', async () => {
	const v = await view(false);
	const a = v.profile.details.find((d) => d.key === 'associations') as unknown as {
		tags: string[];
	};
	assert.deepEqual(a.tags, ['Staff', 'Analytical Engine']);
});

test('R5: an admin sees the private fields, x.* columns included, and never a retired one', async () => {
	const v = await view(true);
	const priv = v.privateFields ?? [];
	assert.deepEqual(
		priv.find((p) => p.key === 'x.Badge No'),
		{ key: 'x.Badge No', label: 'Badge No', value: '0042' }
	);
	assert.equal(priv.find((p) => p.key === 'phone')?.value, '+44 20 7946 0000');
	assert.ok(!priv.some((p) => p.key === 'legacyAccess'), 'a retired field rendered');
	assert.ok(!priv.some((p) => p.key === 'email'), 'the address rendered twice');
	assert.equal(priv.at(-1)?.key, 'x.Badge No', 'x.* fields sort after the schema');
});
