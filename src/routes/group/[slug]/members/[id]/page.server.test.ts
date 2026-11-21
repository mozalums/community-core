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

// member_star in memory, so the load reads through the real stars.ts.
const starRows = new Set<string>();
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string, values: string[]) => {
			const key = values.slice(0, 3).join('|');
			if (/^\s*INSERT INTO member_star/.test(text)) starRows.add(key);
			else if (/^\s*DELETE FROM member_star/.test(text)) starRows.delete(key);
			else if (/^\s*SELECT 1 FROM member_star/.test(text))
				return { rows: starRows.has(key) ? [{}] : [] };
			else throw new Error(`unexpected query: ${text}`);
			return { rows: [] };
		}
	}
});

const { load } = await import('./+page.server');
const { DEFAULT_FIELD_SCHEMA } = await import('$lib/server/field-schema');
const { addStar, removeStar } = await import('$lib/server/stars');

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

const VIEWER = { subject: 'email:viewer@example.org', email: 'viewer@example.org' };
const starView = async (
	user: typeof VIEWER | null,
	access: { member?: { id: string } | null; isGroupAdmin?: boolean }
) =>
	(await load({
		params: { slug: 'example', id: ID },
		locals: { user },
		parent: async () => ({ member: null, isGroupAdmin: false, ...access })
	} as never)) as { starred?: boolean };

test('E51 R2: a member viewer sees starred true after addStar, false after removeStar', async () => {
	const access = { member: { id: 'viewer-row' } };
	assert.equal((await starView(VIEWER, access)).starred, false);
	await addStar('g', VIEWER.subject, ID);
	assert.equal((await starView(VIEWER, access)).starred, true);
	await removeStar('g', VIEWER.subject, ID);
	assert.equal((await starView(VIEWER, access)).starred, false);
});

test('E51 R2: a group admin with no member row gets the star state', async () => {
	await addStar('g', VIEWER.subject, ID);
	assert.equal((await starView(VIEWER, { isGroupAdmin: true })).starred, true);
	await removeStar('g', VIEWER.subject, ID);
});

test('E51 R3: a guest gets no star state at all', async () => {
	await addStar('g', VIEWER.subject, ID);
	assert.ok(!('starred' in (await starView(null, {}))));
	await removeStar('g', VIEWER.subject, ID);
});

test('E51 R2: a signed-in viewer without directory access gets no star state', async () => {
	assert.ok(!('starred' in (await starView(VIEWER, {}))));
});

test("E51 R3: the viewer's own profile carries the star, as the endpoint allows a self-star", async () => {
	const own = { subject: 'email:ada@example.org', email: 'ada@example.org' };
	await addStar('g', own.subject, ID);
	assert.equal((await starView(own, { member: { id: ID } })).starred, true);
	await removeStar('g', own.subject, ID);
});
