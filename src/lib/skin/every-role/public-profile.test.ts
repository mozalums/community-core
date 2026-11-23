import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import type { FakeMember } from '$lib/server/requests-fake';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// Runs on the every-role field set because the default skin has no
// public-profile field: there the box is not on the form and nobody is
// published, which src/routes/group/[slug]/request/public-default.test.ts
// asserts. Application modules are imported dynamically because a static
// import would bind the field schema before the line above runs.

// The property: completing the request form does not publish anyone. Asserted
// over the whole path a new member actually travels (form post, access_request,
// admin approval into a member row, `listPublicMembers`) because each hop has
// its own chance to turn a blank checkbox back into a checked one, and only the
// last of them is what a guest sees.
//
// The answer is stored explicitly rather than left out, so this reads it back
// out of the member row approval created rather than out of the action.

const GROUP = {
	id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44',
	slug: 'example',
	name: 'Example Community',
	landingMd: null,
	status: 'active'
};

const { fakeRequestDb } = await import('$lib/server/requests-fake');
const db = fakeRequestDb();

mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => GROUP } });
mock.module('$lib/server/email', {
	namedExports: { sendMembershipRequestNotice: async () => true }
});
mock.module('$lib/server/rate-limit', {
	namedExports: {
		rateLimitKey: (b: string, id: string) => `${b}:${id}`,
		hashId: (v: string) => v,
		rateLimited: async () => false
	}
});
mock.module('$lib/server/avatars', {
	namedExports: {
		emailMd5: (e: string) => e,
		ensureAvatarRows: async () => new Map<string, string>()
	}
});

// Answers `listPublicMembers` from the member rows approval created, filtered by
// the predicate lifted out of the statement it passed in, and by the key it
// bound. Lifted rather than restated: a change to the set of cell values that
// count as checked, or to which field holds the opt-in, has to move this test
// with it.
function publicMembers(text: string, values: unknown[]) {
	const key = String(values[1]);
	const accepted = (text.match(/IN\s*\(([^)]*)\)/)?.[1] ?? '')
		.split(',')
		.map((s) => s.trim().replace(/^'|'$/g, ''));
	const rows = db.members
		.filter((m: FakeMember) => accepted.includes((m.data[key] ?? '').trim().toLowerCase()))
		.map((m) => ({ id: m.id, name: m.name, email: m.email, public_id: 'p-1' }));
	return { rows, rowCount: rows.length };
}
mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => {
			throw new Error('not reached');
		},
		query: async (text: string, values?: unknown[]) =>
			/FROM member m/.test(text) ? publicMembers(text, values ?? []) : db.query(text, values),
		withTransaction: <T>(fn: (c: unknown) => Promise<T>) => db.withTransaction(fn)
	}
});

const { actions } = await import('../../../routes/group/[slug]/request/+page.server');
const { approveRequest } = await import('$lib/server/requests');
const { listPublicMembers } = await import('$lib/server/members');

const EMAIL = 'nomi@example.org';

function submit(body: Record<string, string>) {
	const fd = new FormData();
	for (const [k, v] of Object.entries(body)) fd.set(k, v);
	return actions.default({
		request: new Request('https://www.example.org/group/example/request', {
			method: 'POST',
			body: fd
		}),
		params: { slug: 'example' },
		locals: { user: { email: EMAIL, subject: `email:${EMAIL}`, name: 'Nomi Vance' } },
		url: new URL('https://www.example.org/group/example/request')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
}

// Register, get approved. Returns the public showcase afterwards.
async function registerAndApprove(body: Record<string, string>) {
	db.reset();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const res = (await submit(body)) as any;
	assert.equal(res?.submitted, true, `the request was rejected: ${res?.data?.error ?? res?.error}`);

	const id = db.requests[0]?.id;
	assert.ok(id, 'the request never reached access_request');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const approved = await approveRequest(GROUP as any, id, { actorSubject: 'email:admin@x' });
	assert.ok(approved?.memberId, 'approval created no member');
	return listPublicMembers(GROUP.id);
}

const member = () => db.members.find((m) => m.email === EMAIL);

const FILLED = {
	firstName: 'Nomi',
	lastName: 'Vance',
	aff_volunteer: 'on'
};

test('a completed request leaves the member off the public homepage', async () => {
	const shown = await registerAndApprove(FILLED);

	assert.equal(
		member()?.data.publicProfile,
		'FALSE',
		'registration stored a checked Public Profile'
	);
	assert.deepEqual(
		shown.map((m) => m.name),
		[],
		'a member who never ticked the box is on the public homepage'
	);
});

test('ticking the box on the request form publishes the member', async () => {
	const shown = await registerAndApprove({ ...FILLED, publicProfile: 'on' });

	assert.equal(member()?.data.publicProfile, 'TRUE');
	assert.deepEqual(
		shown.map((m) => m.name),
		['Nomi Vance'],
		'an explicit opt-in did not reach the public homepage'
	);
});

test('a rejected submit hands the choice back rather than dropping it', async () => {
	db.reset();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const res = (await submit({
		...FILLED,
		'profiles:site': 'linkedin',
		'profiles:handle': 'https://example.org/nomi',
		publicProfile: 'on'
	})) as any;
	assert.equal(res.status, 400);
	assert.equal(res.data.error, 'LinkedIn: the part after linkedin.com/in/');
	assert.equal(res.data.publicProfile, true);
	assert.equal(db.requests.length, 0);
});
