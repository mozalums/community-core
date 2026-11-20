import assert from 'node:assert/strict';
import { test, mock, beforeEach } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// The request workflow on a field set that declares every role: a two-part name, a
// private copy of the address, affiliations, the free-text "Other", the
// public-profile box and a field in the linkedin column. The same workflow on
// the default skin is src/lib/server/requests.test.ts; this file holds what
// that skin has no field to show. Application modules are imported
// dynamically because a static import would bind the field schema before the
// line above runs.

const GROUP = {
	id: '00000000-0000-4000-8000-0000000000f1',
	slug: 'example',
	name: 'Example',
	landingMd: null,
	status: 'active'
};
const ADMIN = {
	id: 'u-admin',
	subject: 'email:admin@example.com',
	email: 'admin@example.com',
	name: 'Admin',
	image: ''
};
const APPLICANT = 'nomi@example.org';

const { fakeRequestDb } = await import('$lib/server/requests-fake');
const db = fakeRequestDb();
const mail = { calls: 0, fail: false };
const revoke = { calls: [] as string[], fail: false };
let limited = false;

const sheetTouched = () => {
	throw new Error('the sheet was reached');
};
mock.module('$lib/server/postgres', {
	namedExports: {
		query: (t: string, v?: unknown[]) => db.query(t, v),
		withTransaction: <T>(fn: (c: unknown) => Promise<T>) => db.withTransaction(fn),
		pgPool: sheetTouched
	}
});
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => true }
});
mock.module('$lib/server/members', {
	namedExports: {
		resolveMember: async () => ({ member: null, firstLogin: false }),
		setSourceRow: sheetTouched
	}
});
mock.module('$lib/server/email', {
	namedExports: {
		sendMembershipApprovedEmail: async () => {
			mail.calls += 1;
			if (mail.fail) throw new Error('SMTP 421');
		},
		sendMembershipRequestNotice: async () => true
	}
});
mock.module('$lib/server/session-store', {
	namedExports: {
		deleteUserSessions: async (subject: string) => {
			revoke.calls.push(subject);
			if (revoke.fail) throw new Error('redis down');
			return 1;
		}
	}
});
mock.module('$lib/server/rate-limit', {
	namedExports: {
		rateLimitKey: (b: string, id: string) => `${b}:${id}`,
		hashId: (v: string) => v,
		rateLimited: async () => limited
	}
});
mock.module('$lib/server/audit', {
	namedExports: {
		actorOf: (u: typeof ADMIN | null) => ({
			actorSubject: u?.subject ?? null,
			actorEmail: u?.email ?? null
		})
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const ROUTES = '../../../routes/group/[slug]/';
const admin = (await import(`${ROUTES}admin/requests/+page.server.ts`)) as {
	actions: Record<string, (e: unknown) => Promise<unknown>>;
	load: (e: unknown) => Promise<{ requests: Awaited<ReturnType<typeof listRequests>> }>;
};
const form = (await import(`${ROUTES}request/+page.server.ts`)) as {
	actions: { default: (e: unknown) => Promise<unknown> };
};
const { listRequests, requestData } = await import('$lib/server/requests');

type Result = { status?: number; data?: { error?: string }; message?: string; submitted?: boolean };

beforeEach(() => {
	db.reset();
	mail.calls = 0;
	mail.fail = false;
	revoke.calls.length = 0;
	revoke.fail = false;
	limited = false;
});

const FILLED = {
	firstName: 'Nomi',
	lastName: 'Vance',
	linkedin: 'https://example.org/nomi',
	aff_volunteer: 'on'
};

async function submit(body: Record<string, string> = FILLED): Promise<Result> {
	const fd = new FormData();
	for (const [k, v] of Object.entries(body)) fd.set(k, v);
	const url = new URL('https://example.org/group/example/request');
	return (await form.actions.default({
		request: new Request(url, { method: 'POST', body: fd }),
		params: { slug: 'example' },
		locals: { user: { email: APPLICANT, subject: `email:${APPLICANT}`, name: 'Nomi Vance' } },
		url
	})) as Result;
}

async function decide(action: 'approve' | 'deny', body: Record<string, string>): Promise<Result> {
	const fd = new FormData();
	for (const [k, v] of Object.entries(body)) fd.set(k, v);
	const url = new URL('https://example.org/group/example/admin/requests');
	return (await admin.actions[action]({
		request: new Request(url, { method: 'POST', body: fd }),
		params: { slug: 'example' },
		locals: { user: ADMIN },
		url
	})) as Result;
}

const pendingId = () => db.requests.find((r) => r.status === 'pending')!.id;

test('approval splits the request by field visibility and derives the typed columns', async () => {
	await submit({ ...FILLED, publicProfile: 'on', otherAffiliations: 'Chess club' });
	await decide('approve', { id: pendingId() });
	const member = db.members.find((m) => m.email === APPLICANT);
	assert.ok(member, 'no member row');
	assert.deepEqual(
		{ ...member, id: undefined, group_id: undefined, status: undefined },
		{
			id: undefined,
			group_id: undefined,
			status: undefined,
			email: APPLICANT,
			name: 'Nomi Vance',
			city: null,
			linkedin: 'https://example.org/nomi',
			data: {
				givenName: 'Nomi',
				familyName: 'Vance',
				website: 'https://example.org/nomi',
				otherAffiliations: 'Chess club',
				staff: 'FALSE',
				volunteer: 'TRUE',
				publicProfile: 'TRUE'
			},
			private_data: { email: APPLICANT }
		}
	);
});

test('requestData writes the address under the email-role field and checkboxes as TRUE/FALSE', () => {
	const data = requestData(
		APPLICANT,
		{ givenName: 'Nomi', city: 'Leeds', interests: 'Chess' },
		{ volunteer: true, staff: false, otherAffiliations: '' }
	);
	assert.deepEqual(data, {
		email: APPLICANT,
		givenName: 'Nomi',
		city: 'Leeds',
		interests: 'Chess',
		volunteer: 'TRUE',
		staff: 'FALSE'
	});
	// The form control's name is not a field key on this skin.
	assert.throws(
		() => requestData(APPLICANT, { firstName: 'Nomi' }, {}),
		/the request names "firstName", which is not a field/
	);
});

test('a two-part name requires the first part, a linkedin-column field its URL, and an affiliation', async () => {
	const error = async (body: Record<string, string>) => {
		const res = await submit(body);
		assert.equal(res.status, 400);
		return res.data?.error;
	};
	assert.equal(await error({ ...FILLED, firstName: '' }), 'First name is required.');
	assert.equal(await error({ ...FILLED, linkedin: '' }), 'LinkedIn URL is required.');
	const { aff_volunteer: _unticked, ...noAffiliation } = FILLED;
	assert.equal(await error(noAffiliation), 'Select at least one affiliation.');
	assert.equal(db.requests.length, 0);
	// The free-text "Other" counts as an affiliation.
	const res = await submit({ ...noAffiliation, otherAffiliations: 'Chess club' });
	assert.equal(res.submitted, true);
});

test('the admin card lists the ticked affiliations first and leaves the name parts to the heading', async () => {
	await submit({ ...FILLED, otherAffiliations: 'Chess club' });
	const rows = await listRequests(GROUP as never);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].name, 'Nomi Vance');
	assert.deepEqual(rows[0].details, [
		{ label: 'Associated with', value: 'Volunteer, Chess club' },
		{ label: 'Website', value: 'https://example.org/nomi' }
	]);
});
