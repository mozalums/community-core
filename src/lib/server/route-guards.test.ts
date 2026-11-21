import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

// The property under test: no mutation under a layout-gated subtree commits for
// a caller the layout would have turned away. Actions are discovered from the
// route tree, not listed, so an admin action added next week is covered the day
// it lands rather than the day someone remembers to extend this file.
//
// The subject is what `mintEmailSession` hands out to anyone who can receive
// mail: a valid session, no membership, no admin grant. Pre-fix, every one of
// these calls returns 200 and lands its side effect.

const ROUTES = new URL('../../routes/', import.meta.url);
const ADMIN_ROUTES = new URL('group/[slug]/admin/', ROUTES);
const STAR_ENDPOINT = new URL('group/[slug]/members/[id]/star/+server.ts', ROUTES);
// Discovery below reads +page.server.ts actions only; a +server.ts endpoint
// under admin/ is invisible to it and has to be listed here by hand.
const EXPORT_ENDPOINT = new URL('group/[slug]/admin/export/+server.ts', ROUTES);

const GROUP = {
	id: '00000000-0000-4000-8000-000000000001',
	slug: 'testgroup',
	name: 'Test Group',
	landingMd: '# before',
	status: 'active'
};

const OUTSIDER = {
	id: 'u-outsider',
	subject: 'email:outsider@example.com',
	email: 'outsider@example.com',
	name: 'Outsider',
	image: ''
};

const MEMBER = {
	id: '00000000-0000-4000-8000-0000000000aa',
	email: 'member@example.com',
	name: 'A Member',
	identSubject: 'email:member@example.com',
	city: null,
	linkedin: null,
	data: {}
};

// Every write the admin actions and the star endpoint can perform. A guard
// that runs late still fires one of these, so "none of them was called" is the
// assertion that the side effect did not land: no access_request decision or
// member row (approveRequest, denyRequest), no landing_md change
// (updateLandingMd), no group_admin row added or removed (grantGroupAdmin,
// revokeGroupAdmin).
const writes = {
	approveRequest: mock.fn(async () => ({ email: 'outsider@example.com', memberId: 'm-1' })),
	denyRequest: mock.fn(async () => ({ email: 'outsider@example.com' })),
	updateLandingMd: mock.fn(async () => {}),
	grantGroupAdmin: mock.fn(async () => true),
	revokeGroupAdmin: mock.fn(async () => ({ subject: 'email:outsider@example.com', email: null })),
	deleteUserSessions: mock.fn(async () => 0),
	sendMembershipApprovedEmail: mock.fn(async () => {}),
	addStar: mock.fn(async () => {}),
	removeStar: mock.fn(async () => {}),
	auditIn: mock.fn(async (_c: unknown, _e: unknown) => {}),
	audit: mock.fn(async (_e: unknown) => {}),
	previewImport: mock.fn(async () => ({ ok: false, errors: ['stub'], warnings: [] })),
	applyImportPlan: mock.fn(async () => ({ ok: false, message: 'stub' }))
};

// Flipped per test: the only difference between the reject and the allow case.
let admin = false;

mock.module('$lib/server/groups', {
	namedExports: {
		getGroupBySlug: async () => GROUP,
		resolveGroupAdmin: async () => admin,
		updateLandingMd: writes.updateLandingMd,
		listGroupAdmins: async () => [],
		grantGroupAdmin: writes.grantGroupAdmin,
		revokeGroupAdmin: writes.revokeGroupAdmin,
		adminSubjectFor: (e: string) => `email:${e.trim().toLowerCase()}`,
		lockAdminChange: async () => admin
	}
});
mock.module('$lib/server/admin', { namedExports: { isAdmin: () => false } });
mock.module('$lib/server/members', {
	namedExports: {
		// MEMBER's own subject resolves to MEMBER, so a plain member is a caller
		// the directory lets in and the admin gate still has to refuse.
		resolveMember: async (_g: string, _e: string, subject: string) => ({
			member: subject === MEMBER.identSubject ? MEMBER : null,
			firstLogin: false
		}),
		getMemberById: async () => MEMBER,
		// The admin overview's load reads it. Loads are not what these tests
		// guard, but the module has to resolve for the actions to be importable.
		countMembers: async () => 0
	}
});
mock.module('$lib/server/requests', {
	namedExports: {
		listRequests: async () => [],
		approveRequest: writes.approveRequest,
		denyRequest: writes.denyRequest
	}
});
mock.module('$lib/server/email', {
	namedExports: { sendMembershipApprovedEmail: writes.sendMembershipApprovedEmail }
});
mock.module('$lib/server/session-store', {
	namedExports: { deleteUserSessions: writes.deleteUserSessions }
});
// The roster import's preview stores a plan and its apply writes members; both
// are the side effects an outsider must not reach.
mock.module('$lib/server/member-import', {
	namedExports: {
		previewImport: writes.previewImport,
		applyImportPlan: writes.applyImportPlan
	}
});
mock.module('$lib/server/stars', {
	namedExports: { addStar: writes.addStar, removeStar: writes.removeStar }
});
// Reads, kept apart from `writes` so the refusal cases can also assert that a
// refused caller never reached the database at all.
const reads = {
	query: mock.fn(async (..._a: unknown[]) => ({ rows: [], rowCount: 0 })),
	withTransaction: mock.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(txClient))
};
const txClient = { query: reads.query };
mock.module('$lib/server/postgres', {
	namedExports: {
		query: reads.query,
		withTransaction: reads.withTransaction
	}
});
// An audit row is a side effect too: a refused caller must not leave one.
mock.module('$lib/server/audit', {
	namedExports: {
		auditIn: writes.auditIn,
		audit: writes.audit,
		actorOf: () => ({ actorSubject: null, actorEmail: null })
	}
});

function resetWrites(): void {
	for (const spy of [...Object.values(writes), ...Object.values(reads)]) spy.mock.resetCalls();
}

function writeCount(): number {
	return Object.values(writes).reduce((n, spy) => n + spy.mock.callCount(), 0);
}

// A POST that carries every field the actions read, so the guard is the only
// thing that can stop them: a missing field would fail(400) first and the
// "nothing was written" assertion would pass for the wrong reason. Approve and
// deny look the request up by `id`, so without it the allow case writes nothing.
const PLAIN_MEMBER = {
	id: 'u-member',
	subject: MEMBER.identSubject,
	email: MEMBER.email,
	name: MEMBER.name,
	image: ''
};

function post(user: typeof OUTSIDER | null) {
	const body = new FormData();
	body.set('id', '00000000-0000-4000-8000-0000000000bb');
	body.set('email', 'outsider@example.com');
	body.set('md', '# defaced');
	body.set('subject', 'email:outsider@example.com');
	body.set('file', new File(['Email\r\noutsider@example.com\r\n'], 'roster.csv'));
	body.set('plan', '00000000-0000-4000-8000-0000000000cc');
	body.set('digest', 'a'.repeat(64));
	const url = new URL(`http://localhost/group/${GROUP.slug}/admin`);
	return {
		params: { slug: GROUP.slug, id: MEMBER.id },
		locals: { sessionId: 's-1', session: null, user },
		url,
		request: new Request(url, { method: 'POST', body })
	};
}

function is403(e: unknown): boolean {
	return (e as { status?: number }).status === 403;
}

type Handler = (event: ReturnType<typeof post>) => Promise<unknown>;

const handlers: { name: string; run: Handler }[] = [];

for (const entry of readdirSync(ADMIN_ROUTES, { recursive: true, withFileTypes: true })) {
	if (entry.name !== '+page.server.ts') continue;
	const file = pathToFileURL(`${entry.parentPath}/${entry.name}`);
	const routeId = decodeURIComponent(file.href.slice(ROUTES.href.length)).replace(
		'/+page.server.ts',
		''
	);
	for (const [action, run] of Object.entries((await import(file.href)).actions ?? {})) {
		handlers.push({ name: `${routeId} ?/${action}`, run: run as Handler });
	}
}

// The admin-access mutations are named, not just counted: they decide who
// passes every other guard in this file.
for (const name of [
	'group/[slug]/admin/access ?/grant',
	'group/[slug]/admin/access ?/revoke',
	'group/[slug]/admin/requests ?/approve',
	'group/[slug]/admin/requests ?/deny',
	'group/[slug]/admin/import ?/preview',
	'group/[slug]/admin/import ?/apply'
]) {
	assert.ok(
		handlers.some((h) => h.name === name),
		`${name} was not discovered`
	);
}

assert.ok(
	handlers.length >= 4,
	`expected the admin actions to be discovered, got ${handlers.length}`
);

const star = await import(STAR_ENDPOINT.href);
handlers.push({ name: 'group/[slug]/members/[id]/star POST', run: star.POST });
handlers.push({ name: 'group/[slug]/members/[id]/star DELETE', run: star.DELETE });

// A read, so what it must not leave behind for an outsider is the file and the
// private-export audit row. ?private=1 is the variant that writes one, which is
// what lets the allow case below prove the guard let an admin through.
const roster = await import(EXPORT_ENDPOINT.href);
handlers.push({
	name: 'group/[slug]/admin/export GET ?private=1',
	run: (event) => {
		const url = new URL(event.url);
		url.pathname += '/export';
		url.searchParams.set('private', '1');
		return roster.GET({ ...event, url, request: new Request(url) });
	}
});

for (const { name, run } of handlers) {
	test(`${name} refuses a signed-in outsider and writes nothing`, async () => {
		admin = false;
		resetWrites();
		await assert.rejects(() => run(post(OUTSIDER)), is403);
		assert.equal(writeCount(), 0, 'a side effect landed for a caller that was refused');
	});

	// Without this the suite would still pass if the guard refused everyone, and
	// a guard that refuses admins is not a guard, it is an outage.
	test(`${name} still writes for a group admin`, async () => {
		admin = true;
		resetWrites();
		await run(post({ ...OUTSIDER, subject: 'email:admin@example.com' }));
		assert.ok(writeCount() > 0, 'the allowed path performed no write — the test proves nothing');
	});
}

// R1 of the export: the whole roster in one request is for admins, so neither
// a stranger with a session nor a member the directory lets in gets a byte of
// it, an audit row, or a query run on their behalf.
test('admin export: an outsider and a plain member get nothing', async () => {
	const { requireDirectoryAccess } = await import('$lib/server/route-guards');
	const run = handlers.find((h) => h.name === 'group/[slug]/admin/export GET ?private=1')!.run;
	admin = false;

	const member = await requireDirectoryAccess({ slug: GROUP.slug }, post(PLAIN_MEMBER).locals);
	assert.equal(member.user.subject, MEMBER.identSubject, 'the plain member must resolve as one');

	for (const user of [OUTSIDER, PLAIN_MEMBER]) {
		resetWrites();
		await assert.rejects(() => run(post(user)), is403, `${user.subject} was not refused`);
		assert.equal(writeCount(), 0, `${user.subject} left a side effect`);
		assert.equal(reads.withTransaction.mock.callCount(), 0, `${user.subject} opened the read`);
		assert.equal(reads.query.mock.callCount(), 0, `${user.subject} ran a query`);
	}

	admin = true;
	resetWrites();
	const res = (await run(post({ ...OUTSIDER, subject: 'email:admin@example.com' }))) as Response;
	assert.equal(res.status, 200);
	assert.ok(reads.query.mock.callCount() > 0, 'the admin path never read the roster');
	assert.equal(writes.auditIn.mock.callCount(), 1, 'the private export wrote no audit row');
});
