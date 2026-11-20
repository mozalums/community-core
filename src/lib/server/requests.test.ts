import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, mock, beforeEach } from 'node:test';
import { fakeRequestDb } from './requests-fake';

// The request workflow driven through its route handlers, as SvelteKit would
// drive them, against an in-memory access_request and member. The default skin
// names a member with one field and asks for nothing else; what the form does
// with affiliations, a two-part name and a private email copy is in
// src/lib/skin/every-role/requests.test.ts.

const GROUP = {
	id: '00000000-0000-4000-8000-0000000000f1',
	slug: 'moz',
	name: 'Moz',
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

const ROUTES = '../../routes/group/[slug]/';
const admin = (await import(`${ROUTES}admin/requests/+page.server.ts`)) as {
	actions: Record<string, (e: unknown) => Promise<unknown>>;
	load: (e: unknown) => Promise<{ requests: Awaited<ReturnType<typeof listRequests>> }>;
};
const form = (await import(`${ROUTES}request/+page.server.ts`)) as {
	actions: { default: (e: unknown) => Promise<unknown> };
};
const { listRequests, requestData } = await import('./requests');
const { AUDIT_INSERT_SQL } = await import('./audit-core');

type Result = { status?: number; data?: { error?: string }; message?: string; submitted?: boolean };

beforeEach(() => {
	db.reset();
	mail.calls = 0;
	mail.fail = false;
	revoke.calls.length = 0;
	revoke.fail = false;
	limited = false;
});

const FILLED = { name: 'Nomi Vance' };

async function submit(body: Record<string, string> = FILLED): Promise<Result> {
	const fd = new FormData();
	for (const [k, v] of Object.entries(body)) fd.set(k, v);
	const url = new URL('https://example.org/group/moz/request');
	return (await form.actions.default({
		request: new Request(url, { method: 'POST', body: fd }),
		params: { slug: 'moz' },
		locals: { user: { email: APPLICANT, subject: `email:${APPLICANT}`, name: 'Nomi Vance' } },
		url
	})) as Result;
}

async function decide(action: 'approve' | 'deny', body: Record<string, string>): Promise<Result> {
	const fd = new FormData();
	for (const [k, v] of Object.entries(body)) fd.set(k, v);
	const url = new URL('https://example.org/group/moz/admin/requests');
	return (await admin.actions[action]({
		request: new Request(url, { method: 'POST', body: fd }),
		params: { slug: 'moz' },
		locals: { user: ADMIN },
		url
	})) as Result;
}

const pendingId = () => db.requests.find((r) => r.status === 'pending')!.id;
const actions = () => db.audits.map((v) => v[1]);

// ---------------------------------------------------------------------------
// Requirement 2: the payload is keyed like member.data
// ---------------------------------------------------------------------------

test('migration 12 widens access_request and drops sheet_appended_at, leaving migration 1 alone', async () => {
	const { MIGRATIONS } = await import('./migrations');
	const m = MIGRATIONS.find((x) => x.version === 12);
	assert.ok(m, 'no migration 12');
	for (const col of [
		/ADD COLUMN IF NOT EXISTS data\s+jsonb NOT NULL/,
		/ADD COLUMN IF NOT EXISTS decided_by\s+text/,
		/ADD COLUMN IF NOT EXISTS deny_reason text/,
		/ADD COLUMN IF NOT EXISTS updated_at\s+timestamptz/,
		/CHECK \(status IN \('pending', 'approved', 'denied'\)\)/,
		/DROP COLUMN IF EXISTS sheet_appended_at/
	]) {
		assert.match(m.sql, col);
	}
	assert.match(MIGRATIONS[0].sql, /sheet_appended_at timestamptz/, 'migration 1 was edited');
});

test('on the default skin a request stores a whole name, no email copy and no affiliation', async () => {
	// Controls the default skin has no field for are not stored under any key.
	await submit({
		...FILLED,
		linkedin: 'https://example.org/nomi',
		aff_staff: 'on',
		publicProfile: 'on',
		otherAffiliations: 'Chess club'
	});
	assert.deepEqual(db.requests[0].data, { name: 'Nomi Vance' });
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
			linkedin: null,
			data: { name: 'Nomi Vance' },
			private_data: {}
		}
	);
});

test('a request with no name is refused and writes nothing', async () => {
	const res = await submit({ firstName: 'Nomi', lastName: 'Vance' });
	assert.equal(res.status, 400);
	assert.equal(res.data?.error, 'Name is required.');
	assert.equal(db.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Requirement 3: the payload stays open-ended
// ---------------------------------------------------------------------------

test('requestData keeps every editable field it is given, keyed by field key', () => {
	const data = requestData(
		APPLICANT,
		{ name: 'Nomi Vance', city: 'Leeds', bio: ' Plays chess ', phone: '555 0100', country: '' },
		{ staff: true, volunteer: false, otherAffiliations: '' }
	);
	// No email key: the default skin keeps the address in the request row alone.
	assert.deepEqual(data, {
		name: 'Nomi Vance',
		city: 'Leeds',
		bio: 'Plays chess',
		phone: '555 0100',
		staff: 'TRUE',
		volunteer: 'FALSE'
	});
});

test('requestData refuses a key that is not an editable field rather than dropping it', () => {
	assert.throws(
		() => requestData(APPLICANT, { name: 'Nomi Vance', firstName: 'Nomi' }, {}),
		/the request names "firstName", which is not a field/
	);
});

test('docs/features.md lists the fields the request form collects, and not the ones it does not', () => {
	const readme = readFileSync(new URL('../../../docs/features.md', import.meta.url), 'utf8');
	const section = readme.split(/^## Membership requests$/m)[1]?.split(/^## /m)[0] ?? '';
	assert.ok(section, 'docs/features.md has no Membership requests section');
	// The affiliations are the skin's, so the page counts them per skin, not as six.
	for (const field of [/first and\s+last name/, /LinkedIn URL/, /one\s+checkbox per `affiliation` field/]) {
		assert.match(section, field);
	}
	assert.doesNotMatch(section, /handle, city, town, country/);
});

// ---------------------------------------------------------------------------
// Requirement 4: the partial unique index decides resubmission
// ---------------------------------------------------------------------------

test('resubmitting while pending leaves one row, updated', async () => {
	await submit();
	await submit({ name: 'Nomi Vance-Okafor' });
	assert.equal(db.requests.length, 1);
	assert.equal(db.requests[0].data.name, 'Nomi Vance-Okafor');
	assert.deepEqual(actions(), ['request.submitted', 'request.submitted']);
});

test('resubmitting after a denial leaves two rows, the denial preserved', async () => {
	await submit();
	await decide('deny', { id: pendingId(), reason: 'not an alum' });
	await submit();
	assert.deepEqual(
		db.requests.map((r) => [r.status, r.deny_reason]),
		[
			['denied', 'not an alum'],
			['pending', null]
		]
	);
});

test('the admin card shows a prior denial beside the new request', async () => {
	await submit();
	await decide('deny', { id: pendingId(), reason: 'not an alum' });
	await submit();
	const { requests } = await admin.load({ params: { slug: 'moz' } });
	assert.equal(requests.length, 1);
	assert.equal(requests[0].priorDenials.length, 1);
	assert.equal(requests[0].priorDenials[0].reason, 'not an alum');
});

test('submissions past the rate limit are refused and write nothing', async () => {
	limited = true;
	const res = await submit();
	assert.equal(res.status, 429);
	assert.equal(db.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Requirement 5: the id is the key
// ---------------------------------------------------------------------------

test('approve acts on the request id, never on the email beside it', async () => {
	await submit();
	const denied = pendingId();
	await decide('deny', { id: denied });
	await submit();
	const fresh = pendingId();

	const res = await decide('approve', { id: denied, email: APPLICANT });
	assert.equal(res.status, 409, 'the email found the newer pending request');
	assert.equal(db.members.length, 0);
	assert.equal(db.requests.find((r) => r.id === fresh)?.status, 'pending');

	assert.equal((await decide('approve', { email: APPLICANT })).status, 400);
	assert.equal((await decide('deny', { email: APPLICANT })).status, 400);
	assert.equal(db.requests.find((r) => r.id === fresh)?.status, 'pending');
});

test('the audit row of a decision targets the request id', async () => {
	await submit();
	const id = pendingId();
	await decide('approve', { id, email: APPLICANT });
	const row = db.audits.find((v) => v[1] === 'request.approved');
	assert.equal(row?.[8], id);
	assert.equal(row?.[0], 'authz');
});

// ---------------------------------------------------------------------------
// Requirement 6: one transaction, a double approve is a no-op
// ---------------------------------------------------------------------------

test('approval locks the pending row, then writes member, decision and audit in that transaction', async () => {
	await submit();
	db.statements.length = 0;
	await decide('approve', { id: pendingId() });
	const steps = db.statements.map((t) =>
		/pg_advisory_xact_lock/.test(t)
			? 'group-lock'
			: /FOR UPDATE/.test(t)
				? 'lock'
				: /INSERT INTO member/.test(t)
					? 'member'
					: /SET status = 'approved'/.test(t)
						? 'decide'
						: t === AUDIT_INSERT_SQL
							? 'audit'
							: t
	);
	assert.deepEqual(steps, ['lock', 'group-lock', 'member', 'audit', 'decide', 'audit']);
	assert.match(
		db.statements[0],
		/WHERE id = \$1 AND group_id = \$2 AND status = 'pending'\s+FOR UPDATE/
	);
});

test('an approval whose audit row fails leaves no member and the request pending', async () => {
	await submit();
	const id = pendingId();
	const original = db.withTransaction;
	db.withTransaction = (fn) =>
		original(async (c) =>
			fn({
				query: async (t: string, v?: unknown[]) => {
					if (t === AUDIT_INSERT_SQL) throw new Error('audit_event missing');
					return (c as { query: typeof db.query }).query(t, v);
				}
			})
		);
	try {
		const res = await decide('approve', { id });
		assert.equal(res.status, 500);
	} finally {
		db.withTransaction = original;
	}
	assert.equal(db.members.length, 0);
	assert.equal(db.requests.find((r) => r.id === id)?.status, 'pending');
});

test('a double approve yields one member and a refusal', async () => {
	await submit();
	const id = pendingId();
	const [a, b] = await Promise.all([decide('approve', { id }), decide('approve', { id })]);
	assert.equal(db.members.length, 1);
	assert.deepEqual([a.status, b.status].sort(), [409, undefined]);
	assert.equal(actions().filter((x) => x === 'request.approved').length, 1);
	assert.equal(mail.calls, 1, 'the refused approval mailed the applicant');
});

test('approving a non-pending id is refused and writes nothing', async () => {
	await submit();
	const id = pendingId();
	await decide('deny', { id });
	const before = db.audits.length;
	const res = await decide('approve', { id });
	assert.equal(res.status, 409);
	assert.equal(db.members.length, 0);
	assert.equal(db.audits.length, before);
	assert.equal(
		(await decide('approve', { id: '00000000-0000-4000-8000-00000000dead' })).status,
		409
	);
});

test('approving an address that is already an active member keeps their profile', async () => {
	db.members.push({
		id: 'm-existing',
		group_id: GROUP.id,
		email: APPLICANT,
		name: 'Edited Name',
		city: null,
		linkedin: null,
		data: { bio: 'mine' },
		private_data: {},
		status: 'active'
	});
	await submit();
	const res = await decide('approve', { id: pendingId() });
	assert.equal(res.status, undefined);
	assert.equal(db.members.length, 1);
	assert.deepEqual(db.members[0].data, { bio: 'mine' });
	assert.equal(db.requests[0].status, 'approved');
});

// ---------------------------------------------------------------------------
// Requirement 7: no forced sync
// ---------------------------------------------------------------------------

test('approval creates the member directly and never calls syncGroup', async () => {
	await submit();
	await decide('approve', { id: pendingId() });
	assert.equal(db.members.length, 1);
	const src = readFileSync(
		new URL(`${ROUTES}admin/requests/+page.server.ts`, import.meta.url),
		'utf8'
	);
	assert.doesNotMatch(src, /\$lib\/server\/sync/);
});

// ---------------------------------------------------------------------------
// Requirement 8: side effects stay outside and best-effort
// ---------------------------------------------------------------------------

test('a throwing approval mail still returns success', async () => {
	await submit();
	mail.fail = true;
	const res = await decide('approve', { id: pendingId(), email: APPLICANT });
	assert.equal(res.status, undefined);
	assert.equal(res.message, `Approved ${APPLICANT}.`);
	assert.equal(mail.calls, 1);
	assert.equal(db.members.length, 1);
});

test('a throwing session revocation still denies successfully', async () => {
	await submit();
	revoke.fail = true;
	const res = await decide('deny', { id: pendingId(), email: APPLICANT });
	assert.equal(res.message, `Denied ${APPLICANT}.`);
	assert.deepEqual(revoke.calls, [`email:${APPLICANT}`]);
	assert.equal(db.requests[0].status, 'denied');
});

test('mail and session revocation run only after the decision commits', async () => {
	await submit();
	const id = pendingId();
	const original = db.withTransaction;
	db.withTransaction = async (fn) => {
		const before = mail.calls + revoke.calls.length;
		const out = await original(fn);
		assert.equal(
			mail.calls + revoke.calls.length,
			before,
			'a side effect ran inside the transaction'
		);
		return out;
	};
	try {
		await decide('approve', { id });
		await submit();
		await decide('deny', { id: pendingId() });
	} finally {
		db.withTransaction = original;
	}
	assert.equal(mail.calls, 1);
	assert.equal(revoke.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Requirement 11: one source
// ---------------------------------------------------------------------------

test('listRequests reads the table alone and never the sheet', async () => {
	await submit();
	db.statements.length = 0;
	const rows = await listRequests(GROUP as never);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].name, 'Nomi Vance');
	// The name heads the card, and the default skin asks for nothing else.
	assert.deepEqual(rows[0].details, []);
	assert.equal(db.statements.length, 1);
	assert.match(db.statements[0], /FROM access_request r/);
});

// ---------------------------------------------------------------------------
// Requirement 12: the sheet implementation is gone
// ---------------------------------------------------------------------------

test('the sheet request implementation and the unused-table note are gone', async () => {
	const src = readFileSync(new URL('./requests.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(src, /sheet-rw|REQUESTS_TAB/);
	assert.equal('REQUESTS_TAB' in (await import('./requests')), false);
	const readme = ['README.md', 'docs/features.md', 'docs/data-model.md']
		.map((p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8'))
		.join('\n');
	assert.doesNotMatch(readme, /tab literally named \*\*`Requests`\*\*/);
	assert.doesNotMatch(readme, /unused `access_request` table/);
});
