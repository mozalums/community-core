import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { fakeRequestDb, type FakeMember } from '$lib/server/requests-fake';

// The property: completing the request form does not publish anyone. Asserted
// over the whole path a new member actually travels (form post, access_request,
// admin approval into a member row, `listPublicMembers`) because each hop has
// its own chance to turn a blank checkbox back into a checked one, and only the
// last of them is what a guest sees.
//
// The default skin has no public-profile field, so here the property holds by
// there being nothing to tick: a posted box is stored under no key and the
// showcase is empty. The opt-in itself, on a skin that declares the field, is
// src/lib/skin/every-role/public-profile.test.ts.

const GROUP = {
	id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44',
	slug: 'example',
	name: 'Example Community',
	landingMd: null,
	status: 'active'
};

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

const { actions, load } = await import('./+page.server');
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

const FILLED = { name: 'Nomi Vance' };

test('on a skin with no public-profile field a completed request publishes nobody', async () => {
	const shown = await registerAndApprove(FILLED);
	assert.deepEqual(member()?.data, { name: 'Nomi Vance' });
	assert.deepEqual(shown, []);
});

test('a posted public-profile box is stored under no key and publishes nobody', async () => {
	const shown = await registerAndApprove({ ...FILLED, publicProfile: 'on' });
	assert.deepEqual(member()?.data, { name: 'Nomi Vance' });
	assert.deepEqual(member()?.private_data, {});
	assert.deepEqual(shown, []);
});

test('the form asks for no public profile or affiliation, and offers the skin’s links field', async () => {
	const data = (await load({
		parent: async () => ({ member: null, isGroupAdmin: false }),
		params: { slug: 'example' },
		locals: { user: { email: EMAIL, subject: `email:${EMAIL}`, name: 'Nomi Vance' } },
		url: new URL('https://www.example.org/group/example/request')
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any)) as any;
	assert.deepEqual(data.nameControls, [{ control: 'name', required: false }]);
	assert.deepEqual(
		data.linkFields.map((f: { name: string; required: boolean }) => [f.name, f.required]),
		[['links', false]]
	);
	assert.deepEqual(data.asks, {
		affiliation: false,
		otherAffiliation: false,
		publicProfile: false
	});
	assert.deepEqual(data.affiliations, []);
	assert.equal(data.prefill.name, 'Nomi Vance');
});
