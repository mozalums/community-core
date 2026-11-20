import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// Runs on the every-role field set because the default skin has no
// public-profile field and so shows no member to a guest at all, which
// src/routes/group/[slug]/page.server.test.ts asserts. The loader is imported
// dynamically because a static import would bind the field schema before the
// line above runs.

// The property: nothing an unauthenticated visitor is handed on the public
// landing page is an address. Not "the loader does not select m.email" — that is
// a line, and the next loader to join the payload will not have read it. This
// asserts over the serialized return, so any field added anywhere below it that
// carries an address fails here.
//
// The consent the assertion encodes is the one printed on every member's edit
// page: "your name and photo may appear on the public homepage". Name and photo.

const GROUP = {
	id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44',
	slug: 'example',
	name: 'Example Community',
	landingMd: '## Welcome\n\nA private community directory.'
};

// Rows as `listPublicMembers` reads them out of Postgres: the join is on the
// address, so the address is in the result set whatever the payload ends up
// holding. Mixed shapes on purpose — an uploaded photo, none, and no name.
const ROWS = [
	{
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Ada Lovelace',
		email: 'ada@example.org',
		public_id: '9b1c7e42-3d5a-4f60-8a21-0c4e7b9d2f13'
	},
	{
		id: '22222222-2222-4222-8222-222222222222',
		name: 'Grace Hopper',
		email: 'grace.hopper+alum@example.com',
		public_id: null
	},
	{
		id: '33333333-3333-4333-8333-333333333333',
		name: null,
		email: 'q@sub.domain.co.uk',
		public_id: null
	}
];

mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => GROUP } });
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async () => ({ rows: ROWS, rowCount: ROWS.length }),
		withTransaction: async () => assert.fail('the directory load writes nothing')
	}
});

const { load } = await import('../../../routes/group/[slug]/+page.server');

// Practical RFC-5322: enough to catch every address the roster actually holds,
// which is the claim under test. A false positive here is a failing test, not a
// missed leak, so it errs wide.
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function loadPublic() {
	return load({
		parent: async () => ({ member: null, isGroupAdmin: false }),
		params: { slug: 'example' },
		url: new URL('https://www.example.org/')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
}

test('the public landing payload carries no address', async () => {
	const data = await loadPublic();
	const serialized = JSON.stringify(data);

	const found = serialized.match(new RegExp(ADDRESS, 'g')) ?? [];
	assert.deepEqual(found, [], `serialized landing payload contains ${found.length} address(es)`);
});

test('every public member still carries a name and a photo', async () => {
	const data = await loadPublic();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const members = (data as any).publicMembers as Array<Record<string, unknown>>;
	assert.equal(members.length, ROWS.length);

	for (const m of members) {
		assert.deepEqual(Object.keys(m).sort(), ['avatarId', 'id', 'name']);
	}
	// The uploaded photo id survives; the member without one falls to initials.
	assert.equal(members[0].avatarId, ROWS[0].public_id);
	assert.equal(members[1].avatarId, null);
});

test('the public landing payload carries no Gravatar hash', async () => {
	// The address is gone (above), but md5 of it discloses the same membership:
	// it sends a guest's browser to Automattic once per member, and it confirms
	// membership for anyone who can hash a candidate address. Asserted
	// over the serialized return rather than over the select list, so a hash
	// re-added anywhere below this loader fails here.
	const serialized = JSON.stringify(await loadPublic());
	const found = serialized.match(/[0-9a-f]{32}/g) ?? [];
	assert.deepEqual(found, [], `serialized landing payload contains ${found.length} md5(s)`);
	assert.ok(!serialized.includes('gravatar'), 'landing payload names gravatar');
});
