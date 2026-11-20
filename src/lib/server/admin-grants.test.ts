import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, mock, beforeEach } from 'node:test';
import type { AuditEntry } from './audit-core';

// Who is a group admin, and who can change that. Everything below the
// postgres module is real: the resolver, isGroupAdmin, the grant helpers and
// the /admin/access actions. The database is a fake that answers a member
// query with that member's row, so a resolver that consulted a
// "Dash Permissions" value left in member.data would find it and say yes.

const GROUP = {
	id: '00000000-0000-4000-8000-000000000001',
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

const db = {
	members: new Map<string, Record<string, string>>(),
	admins: new Map<string, string | null>()
};
const statements: string[] = [];
let failAdminLookup = false;
let envAdmins: string[] = [];
const warnings: string[] = [];
const audits: { entry: AuditEntry; client: unknown }[] = [];

async function query(text: string, values: unknown[] = []) {
	statements.push(text);
	if (/^\s*SELECT 1 AS one FROM group_admin/.test(text)) {
		if (failAdminLookup) throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
		const hit = db.admins.has(String(values[1]));
		return { rows: hit ? [{ one: 1 }] : [], rowCount: hit ? 1 : 0 };
	}
	if (/FROM "group" WHERE id = \$1 FOR NO KEY UPDATE/.test(text)) {
		return { rows: [{ one: 1 }], rowCount: 1 };
	}
	if (/^\s*INSERT INTO group_admin/.test(text)) {
		if (db.admins.has(String(values[1]))) return { rows: [], rowCount: 0 };
		db.admins.set(String(values[1]), String(values[2]));
		return { rows: [], rowCount: 1 };
	}
	if (/^\s*DELETE FROM group_admin/.test(text)) {
		const subject = String(values[1]);
		if (!db.admins.has(subject)) return { rows: [], rowCount: 0 };
		const email = db.admins.get(subject) ?? null;
		db.admins.delete(subject);
		return { rows: [{ ident_subject: subject, email }], rowCount: 1 };
	}
	if (/INSERT INTO member/.test(text)) {
		db.members.set(String(values[1]), JSON.parse(String(values[5])));
		return { rows: [], rowCount: 1 };
	}
	if (/FROM member/.test(text) && typeof values[1] === 'string') {
		const data = db.members.get(values[1]);
		return { rows: data ? [{ data }] : [], rowCount: data ? 1 : 0 };
	}
	if (/FROM "group" WHERE slug/.test(text)) {
		return { rows: [GROUP], rowCount: 1 };
	}
	if (/SELECT count\(\*\)/.test(text)) return { rows: [{ n: '0' }], rowCount: 1 };
	return { rows: [], rowCount: 0 };
}
const TX = { query };

mock.module('$lib/server/postgres', {
	namedExports: {
		query,
		withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn(TX)
	}
});
mock.module('$lib/server/admin', {
	namedExports: { isAdmin: (s: string | null | undefined) => !!s && envAdmins.includes(s) }
});
mock.module('$lib/server/log', {
	namedExports: {
		log: {
			debug() {},
			info() {},
			warn: (msg: string) => void warnings.push(msg),
			error() {}
		}
	}
});
mock.module('$lib/server/audit', {
	namedExports: {
		auditIn: async (client: unknown, entry: AuditEntry) => void audits.push({ entry, client }),
		actorOf: (u: typeof ADMIN | null) => ({
			actorSubject: u?.subject ?? null,
			actorEmail: u?.email ?? null
		})
	}
});
mock.module('$lib/server/members', {
	namedExports: { resolveMember: async () => ({ member: null, firstLogin: false }) }
});

const { resolveGroupAdmin } = await import('./groups');
const { actions } = await import('../../routes/group/[slug]/admin/access/+page.server');

beforeEach(() => {
	db.members.clear();
	db.admins.clear();
	statements.length = 0;
	warnings.length = 0;
	audits.length = 0;
	failAdminLookup = false;
	envAdmins = [];
});

function user(email: string) {
	return { ...ADMIN, id: `u-${email}`, subject: `email:${email}`, email };
}

type Action = (e: unknown) => Promise<unknown>;
function post(name: 'grant' | 'revoke', as: typeof ADMIN | null, form: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	const url = new URL(`http://localhost/group/${GROUP.slug}/admin/access`);
	return (actions[name] as Action)({
		params: { slug: GROUP.slug },
		locals: { user: as },
		url,
		request: new Request(url, { method: 'POST', body })
	});
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

test('a member whose only claim is a Dash Permissions value is not an admin', async () => {
	db.members.set('sheetadmin@example.com', {
		Email: 'sheetadmin@example.com',
		'Dash Permissions': 'admin'
	});
	assert.equal(await resolveGroupAdmin(GROUP, user('sheetadmin@example.com')), false);
	assert.ok(
		statements.every((s) => !/FROM member/.test(s)),
		'the resolver read the member row'
	);
});

test('a member the migration copied into group_admin is an admin', async () => {
	db.admins.set('email:copied@example.com', 'copied@example.com');
	assert.equal(await resolveGroupAdmin(GROUP, user('copied@example.com')), true);
});

test('a failing group_admin query resolves to false and logs a warning', async () => {
	db.admins.set('email:admin@example.com', 'admin@example.com');
	failAdminLookup = true;
	assert.equal(await resolveGroupAdmin(GROUP, ADMIN), false);
	assert.deepEqual(warnings, ['group-admin.lookup-failed']);
});

test('ADMIN_SUBJECTS is checked first and needs no database', async () => {
	envAdmins = ['email:breakglass@example.com'];
	failAdminLookup = true;
	assert.equal(await resolveGroupAdmin(GROUP, user('breakglass@example.com')), true);
	assert.deepEqual(statements, [], 'the env check issued a query');
});

// ---------------------------------------------------------------------------
// /admin/access
// ---------------------------------------------------------------------------

test('self-revoke is refused, says why, and removes nothing', async () => {
	db.admins.set(ADMIN.subject, ADMIN.email);
	const out = (await post('revoke', ADMIN, { subject: 'EMAIL:Admin@Example.com' })) as {
		status: number;
		data: { error: string };
	};
	assert.equal(out.status, 400);
	assert.match(out.data.error, /cannot revoke your own admin access/);
	assert.ok(db.admins.has(ADMIN.subject), 'the grant was removed');
	assert.deepEqual(audits, []);
});

test('a grant may name an address that has never signed in, and is audited as authz in the same transaction', async () => {
	db.admins.set(ADMIN.subject, ADMIN.email);
	const out = (await post('grant', ADMIN, { email: '  Stranger@Example.com ' })) as {
		message: string;
	};
	assert.match(out.message, /stranger@example\.com is now an admin/);
	assert.equal(db.admins.get('email:stranger@example.com'), 'stranger@example.com');
	assert.equal(audits.length, 1);
	assert.equal(audits[0].client, TX, 'the audit row is outside the grant transaction');
	assert.deepEqual(
		{
			category: audits[0].entry.category,
			action: audits[0].entry.action,
			actor: audits[0].entry.actorSubject,
			target: audits[0].entry.targetSubject,
			group: audits[0].entry.groupId
		},
		{
			category: 'authz',
			action: 'group-admin.granted',
			actor: ADMIN.subject,
			target: 'email:stranger@example.com',
			group: GROUP.id
		}
	);
	assert.equal(await resolveGroupAdmin(GROUP, user('stranger@example.com')), true);
});

test('a revoke removes the grant and is audited as authz in the same transaction', async () => {
	db.admins.set(ADMIN.subject, ADMIN.email);
	db.admins.set('email:other@example.com', 'other@example.com');
	await post('revoke', ADMIN, { subject: 'email:other@example.com' });
	assert.equal(db.admins.has('email:other@example.com'), false);
	assert.equal(audits.length, 1);
	assert.equal(audits[0].client, TX);
	assert.equal(audits[0].entry.category, 'authz');
	assert.equal(audits[0].entry.action, 'group-admin.revoked');
	assert.equal(audits[0].entry.targetEmail, 'other@example.com');
	assert.equal(await resolveGroupAdmin(GROUP, user('other@example.com')), false);
});

// The request's guard passes, then another admin's revoke of this actor commits
// before this request's transaction takes the group lock.
function postAfterLosingAdmin(name: 'grant' | 'revoke', form: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	return (actions[name] as Action)({
		params: { slug: GROUP.slug },
		locals: { user: ADMIN },
		request: {
			formData: async () => {
				db.admins.delete(ADMIN.subject);
				return body;
			}
		}
	}) as Promise<{ status: number; data: { error: string } }>;
}

test('an admin revoked after their guard passed can neither grant nor revoke', async () => {
	for (const [name, form] of [
		['grant', { email: 'late@example.com' }],
		['revoke', { subject: 'email:other@example.com' }]
	] as const) {
		db.admins.set(ADMIN.subject, ADMIN.email);
		db.admins.set('email:other@example.com', 'other@example.com');
		statements.length = 0;
		const out = await postAfterLosingAdmin(name, form);
		assert.equal(out.status, 403, name);
		assert.match(out.data.error, /no longer hold admin access/);
		assert.equal(db.admins.has('email:late@example.com'), false);
		assert.equal(db.admins.has('email:other@example.com'), true);
		assert.deepEqual(audits, []);
		const lock = statements.findIndex((s) => /FOR NO KEY UPDATE/.test(s));
		const recheck = statements.findIndex((s, i) => i > lock && /FROM group_admin/.test(s));
		assert.ok(lock >= 0 && recheck > lock, `${name} did not re-check the actor after taking the lock`);
	}
});

test('revoking the group grant of an ADMIN_SUBJECTS account says their access remains', async () => {
	envAdmins = ['email:global@example.com'];
	db.admins.set(ADMIN.subject, ADMIN.email);
	db.admins.set('email:global@example.com', null);
	const out = (await post('revoke', ADMIN, { subject: 'email:global@example.com' })) as {
		message: string;
	};
	assert.equal(db.admins.has('email:global@example.com'), false);
	assert.doesNotMatch(out.message, /no longer an admin/);
	assert.match(out.message, /ADMIN_SUBJECTS and still administers every group/);
	assert.equal(await resolveGroupAdmin(GROUP, user('global@example.com')), true);
	assert.equal(audits.length, 1);
});

test('a grant that is not an email address is refused without a write', async () => {
	db.admins.set(ADMIN.subject, ADMIN.email);
	const out = (await post('grant', ADMIN, { email: 'not-an-address' })) as { status: number };
	assert.equal(out.status, 400);
	assert.equal(db.admins.size, 1);
	assert.deepEqual(audits, []);
});

test('a repeat grant changes nothing and records nothing', async () => {
	db.admins.set(ADMIN.subject, ADMIN.email);
	db.admins.set('email:twice@example.com', 'twice@example.com');
	const out = (await post('grant', ADMIN, { email: 'twice@example.com' })) as {
		message: string;
	};
	assert.match(out.message, /already an admin/);
	assert.deepEqual(audits, []);
});

test('R8: docs/features.md Admin access names two sources and the /admin/access page', () => {
	const readme = readFileSync(new URL('../../../docs/features.md', import.meta.url), 'utf8');
	const section = readme.split(/^## Admin access$/m)[1]?.split(/^## /m)[0];
	assert.ok(section, 'docs/features.md has no Admin access section');
	for (const name of ['ADMIN_SUBJECTS', 'group_admin', '/admin/access']) {
		assert.ok(section.includes(name), `Admin access does not name ${name}`);
	}
	const sources = section
		.split(/\n(?=- )/)
		.slice(1)
		.map((block) => block.split(/\n\s*\n/)[0]);
	assert.equal(sources.length, 2, `Admin access lists ${sources.length} sources`);
	for (const source of sources) {
		assert.doesNotMatch(source, /sheet|spreadsheet|Dash Permissions/i, 'a source is the sheet');
	}
	assert.doesNotMatch(section, /\bany of these\b|grant admin straight in the spreadsheet/i);
	if (/Dash Permissions/.test(section)) assert.match(section, /no longer grants anything/);
});

// ---------------------------------------------------------------------------
// Migration 11: the one-time copy. What it does to rows is in
// admin-grants.pg.test.ts; this holds what can be checked without a database.
// ---------------------------------------------------------------------------

test('migration 11 freezes the accepted values as a literal', async () => {
	const { MIGRATIONS } = await import('./migrations');
	const m = MIGRATIONS.find((x) => x.version === 11);
	assert.ok(m, 'no migration 11');
	assert.equal(m.name, 'group_admin_from_dash_permissions');

	const literal = m.sql.match(/IN \(('[^)]*')\)/)?.[1];
	assert.ok(literal, 'no accepted-values literal');
	const frozen = literal.split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
	assert.deepEqual(frozen, ['admin', 'owner', 'superadmin']);
	assert.match(m.sql, /IF admins_after < admins_before THEN\s+RAISE EXCEPTION/);
});
