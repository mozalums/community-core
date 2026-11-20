import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { AUDIT_INSERT_SQL } from './audit-core';
import {
	GROUP_LOCK_SQL,
	bindSubjectIn,
	MemberWriteError,
	SELECT_FOR_UPDATE_SQL,
	UPDATE_SQL,
	computeDelta,
	createMemberIn,
	deriveColumns,
	hardPurgeMemberIn,
	softRemoveMemberIn,
	updateMemberIn,
	validatePatch,
	type Client,
	type UpdateInput
} from './member-write-core';
import type { FieldDef } from './field-schema';

// The member write path, driven against a client that records every statement,
// so the order inside the transaction is asserted rather than assumed. It
// runs on the default skin; what a write does with a checkbox, an avatar field
// or a two-part name is in src/lib/skin/every-role/member-write.test.ts.

// For the pure steps that take a schema: the field kinds the default skin has
// none of.
const SCHEMA: readonly FieldDef[] = (
	[
		{
			key: 'givenName',
			label: 'Given name',
			type: 'text',
			visibility: 'members',
			role: 'givenName',
			column: 'name'
		},
		{
			key: 'familyName',
			label: 'Family name',
			type: 'text',
			visibility: 'members',
			role: 'familyName',
			column: 'name'
		},
		{
			key: 'email',
			label: 'Email',
			type: 'email',
			visibility: 'private',
			role: 'email',
			column: 'email'
		},
		{ key: 'bio', label: 'Bio', type: 'longtext', visibility: 'members', role: 'bio' },
		{ key: 'staff', label: 'Staff', type: 'checkbox', visibility: 'members', role: 'affiliation' },
		{ key: 'city', label: 'City', type: 'text', visibility: 'members', column: 'city' },
		{ key: 'website', label: 'Website', type: 'url', visibility: 'members', column: 'linkedin' },
		{ key: 'photo', label: 'Photo', type: 'url', visibility: 'private', role: 'avatar' },
		{
			key: 'legacyAccess',
			label: 'Legacy access',
			type: 'text',
			visibility: 'private',
			role: 'retired'
		}
	] satisfies Omit<FieldDef, 'order'>[]
).map((f, i) => ({ ...f, order: (i + 1) * 10 }));

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

const GROUP = { id: '00000000-0000-4000-8000-000000000001', slug: 'example' };
const MEMBER_ID = '00000000-0000-4000-8000-0000000000aa';
const ADMIN = { actorSubject: 'email:admin@example.org', actorEmail: 'admin@example.org' };
const SELF = { actorSubject: 'oidc:ada', actorEmail: 'ada@example.org' };
const STRANGER = { actorSubject: 'email:eve@example.org', actorEmail: 'eve@example.org' };

type Stmt = { text: string; values: unknown[] };
let log: Stmt[] = [];
let row: Record<string, unknown> | null;

const client = {
	query: async (text: string, values: unknown[] = []) => {
		log.push({ text, values });
		if (text === SELECT_FOR_UPDATE_SQL || /^\s*DELETE FROM member/.test(text)) {
			return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
		}
		if (/INSERT INTO member/.test(text)) return { rows: [{ id: MEMBER_ID }], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	}
} as unknown as Client;

beforeEach(() => {
	log = [];
	row = {
		email: 'ada@example.org',
		ident_subject: 'oidc:ada',
		data: { name: 'Ada Byron', country: 'UK' },
		private_data: { phone: '+44 20 7946 0000' },
		name: 'Ada Byron',
		city: null,
		linkedin: null
	};
});

const update = (over: Partial<UpdateInput>) =>
	updateMemberIn(client, {
		group: GROUP,
		memberId: MEMBER_ID,
		actor: ADMIN,
		authority: { admin: true },
		writer: 'form',
		recordPrivateValues: false,
		patch: {},
		...over
	});

const kinds = () =>
	log.map((s) =>
		s.text === GROUP_LOCK_SQL
			? 'lock'
			: s.text === SELECT_FOR_UPDATE_SQL
				? 'select'
				: s.text === UPDATE_SQL
					? 'update'
					: s.text === AUDIT_INSERT_SQL
						? 'audit'
						: s.text.trim().split(/\s+/).slice(0, 3).join(' ')
	);

function auditRow(): Record<string, unknown> {
	const hits = log.filter((s) => s.text === AUDIT_INSERT_SQL);
	assert.equal(hits.length, 1, `expected one audit insert, got ${hits.length}`);
	const [category, action, , , , , targetEmail, , targetId, before, after, meta] = hits[0].values;
	const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
	return {
		category,
		action,
		targetEmail,
		targetId,
		before: j(before),
		after: j(after),
		meta: j(meta)
	};
}

// ---------------------------------------------------------------------------
// 1: the split
// ---------------------------------------------------------------------------

test('R1: member-write-core imports no SvelteKit or $env, and member-write binds it to withTransaction', () => {
	const core = read('src/lib/server/member-write-core.ts');
	assert.doesNotMatch(
		core,
		/from '\$(env|app)\/|from '@sveltejs\/kit'|from '\$lib\/server\/postgres'/
	);
	const app = read('src/lib/server/member-write.ts');
	assert.match(app, /import \{[^}]*withTransaction[^}]*\} from '\$lib\/server\/postgres'/);
	for (const fn of ['updateMember', 'createMemberIn', 'softRemoveMember', 'hardPurgeMember']) {
		assert.match(app, new RegExp(`export (async )?function ${fn}\\b`), `${fn} not exposed`);
	}
});

test('R1: every member mutation the app makes goes through member-write', () => {
	assert.match(read('src/lib/server/member-edit.ts'), /from '\$lib\/server\/member-write'/);
	assert.match(read('src/lib/server/requests.ts'), /createMemberIn\(client,/);
	assert.doesNotMatch(read('src/lib/server/requests.ts'), /INSERT INTO member/);
	for (const f of readdirSync(new URL('./', import.meta.url))) {
		if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
		if (['member-write-core.ts', 'migrations.ts', 'requests-fake.ts'].includes(f)) continue;
		assert.doesNotMatch(
			read(`src/lib/server/${f}`),
			/UPDATE member\b|INSERT INTO member\b|DELETE FROM member\b/,
			`${f} mutates member outside member-write`
		);
	}
});

test('R10: a first-login identity bind is locked, conditional, and audited on the same client', async () => {
	const bind = {
		groupId: GROUP.id,
		memberId: MEMBER_ID,
		email: 'ada@example.org',
		subject: 'oidc:ada',
		actor: SELF
	};
	assert.equal(await bindSubjectIn(client, bind), true);
	assert.deepEqual(kinds(), ['lock', 'UPDATE member SET', 'audit']);
	assert.match(log[1].text, /AND ident_subject IS NULL/);
	assert.equal(auditRow().action, 'member.identity-bound');

	log = [];
	const lost = {
		query: async (t: string, v: unknown[]) => (
			log.push({ text: t, values: v }),
			{ rows: [], rowCount: 0 }
		)
	};
	assert.equal(await bindSubjectIn(lost as unknown as Client, bind), false);
	assert.ok(!kinds().includes('audit'), 'a bind another login won is audited');

	const failing = {
		query: async (t: string) => {
			if (t === AUDIT_INSERT_SQL) throw new Error('audit down');
			return { rows: [], rowCount: 1 };
		}
	};
	await assert.rejects(() => bindSubjectIn(failing as unknown as Client, bind), /audit down/);
});

// ---------------------------------------------------------------------------
// 2 and 11: one transaction, in order
// ---------------------------------------------------------------------------

test('R2: an update runs advisory lock, SELECT FOR UPDATE, UPDATE, audit, in that order', async () => {
	assert.equal(await update({ patch: { name: 'Augusta Byron' } }), 1);
	assert.deepEqual(kinds(), ['lock', 'select', 'update', 'audit']);
	assert.deepEqual(log[0].values, [GROUP.id], 'the lock is not keyed on the group');
	assert.match(GROUP_LOCK_SQL, /pg_advisory_xact_lock/, 'not transaction-scoped');
	assert.match(SELECT_FOR_UPDATE_SQL, /WHERE group_id = \$1 AND id = \$2[\s\S]*FOR UPDATE/);
	assert.deepEqual(log[1].values, [GROUP.id, MEMBER_ID]);
});

test('R2: a patch that changes nothing stops after the read and writes nothing', async () => {
	assert.equal(await update({ patch: { name: ' Ada Byron ', country: 'UK', bio: '' } }), 0);
	assert.deepEqual(kinds(), ['lock', 'select']);
});

test('R2: a member gone since the form rendered is a 404, after the lock and read', async () => {
	row = null;
	await assert.rejects(
		() => update({ patch: { name: 'X' } }),
		(e: unknown) => e instanceof MemberWriteError && e.status === 404
	);
	assert.deepEqual(kinds(), ['lock', 'select']);
});

test('R11: the delta is computed against the locked row, not a caller copy', () => {
	const current = { name: 'Ada', staff: 'TRUE', bio: 'old' };
	const { next, changed } = computeDelta(current, {
		name: 'Ada',
		bio: '  ',
		staff: true,
		volunteer: false,
		alum: true,
		handle: ' enchantress '
	});
	assert.deepEqual(changed, ['bio', 'alum', 'handle']);
	assert.deepEqual(next, { name: 'Ada', staff: 'TRUE', alum: 'TRUE', handle: 'enchantress' });
	assert.deepEqual(current, { name: 'Ada', staff: 'TRUE', bio: 'old' }, 'input mutated');
});

test('R11: a hand-typed checkbox marker that reads as ticked is not rewritten', () => {
	assert.deepEqual(computeDelta({ staff: 'x' }, { staff: true }).changed, []);
	assert.deepEqual(computeDelta({ staff: 'no' }, { staff: true }).changed, ['staff']);
});

// ---------------------------------------------------------------------------
// 3: the concurrency story is in the code
// ---------------------------------------------------------------------------

test('R3: the module comment states the uuid address, one read and one write, the lock and the checkboxes', () => {
	const head = read('src/lib/server/member-write-core.ts')
		.split(/^import /m)[0]
		.replace(/\n\/\/ ?/g, ' ');
	assert.match(head, /immutable uuid/);
	assert.match(head, /advisory lock keyed on the group/);
	assert.match(head, /FOR UPDATE/);
	assert.match(head, /one statement/);
	assert.match(head, /checkboxes[\s\S]*same UPDATE/);
	assert.match(head, /cannot\s+recur/);
});

// ---------------------------------------------------------------------------
// 4: unknown keys are refused
// ---------------------------------------------------------------------------

test('R4: a key outside the schema is a 400 and nothing is written', async () => {
	await assert.rejects(
		() => update({ patch: { name: 'Augusta', 'First Name': 'Augusta' } }),
		(e: unknown) =>
			e instanceof MemberWriteError && e.status === 400 && /First Name/.test(e.message)
	);
	assert.ok(!kinds().includes('update'));
	assert.ok(!kinds().includes('audit'));
});

test('R4: a form cannot write a field no form shows, nor give a checkbox text', () => {
	const opts = { writer: 'form' as const, mayWritePrivate: true, schema: SCHEMA };
	for (const patch of [
		{ email: 'x@example.org' },
		{ photo: 'u' },
		{ legacyAccess: 'y' },
		{ 'x.Team': 't' }
	]) {
		assert.throws(
			() => validatePatch(patch as unknown as Record<string, string>, opts),
			(e: unknown) => (e as MemberWriteError).status === 400
		);
	}
	assert.throws(() => validatePatch({ staff: 'TRUE' }, opts), /wrong type/);
	assert.doesNotThrow(() => validatePatch({ photo: 'u' }, { ...opts, allow: ['photo'] }));
	// The default skin's own form-unwritable keys: an unmapped column.
	assert.throws(
		() => validatePatch({ 'x.Team': 't' }, { writer: 'form', mayWritePrivate: true }),
		(e: unknown) => (e as MemberWriteError).status === 400
	);
});

// ---------------------------------------------------------------------------
// 5: private-field authority lives in the write path
// ---------------------------------------------------------------------------

test('R5: a non-admin, non-owner private write is a 403 after only the lock and the read', async () => {
	await assert.rejects(
		() => update({ actor: STRANGER, authority: { admin: false }, patch: { phone: '555 0100' } }),
		(e: unknown) => e instanceof MemberWriteError && e.status === 403
	);
	assert.deepEqual(kinds(), ['lock', 'select']);
});

test('R5: an admin, and the member themselves, may write a private field', async () => {
	assert.equal(await update({ authority: { admin: true }, patch: { phone: 'A' } }), 1);
	log = [];
	assert.equal(
		await update({ actor: SELF, authority: { admin: false }, patch: { phone: 'B' } }),
		1
	);
});

test('R5: the caller cannot claim to be the member; that is read from the locked row', async () => {
	row = { ...row!, ident_subject: 'oidc:someone-else', email: 'someone@example.org' };
	await assert.rejects(
		() => update({ actor: SELF, authority: { admin: false }, patch: { phone: '555' } }),
		(e: unknown) => (e as MemberWriteError).status === 403
	);
});

// ---------------------------------------------------------------------------
// 6: name is derived; city and linkedin are promoted
// ---------------------------------------------------------------------------

test('R6: a write that touches no name part keeps the stored name', () => {
	const prev = { name: 'Full Name Row', city: 'Paris', linkedin: null };
	assert.deepEqual(deriveColumns({ bio: 'b' }, ['bio'], prev), prev);
	assert.deepEqual(deriveColumns({ bio: 'b' }, ['bio'], prev, SCHEMA), prev);
	// The default skin's one name field, then a skin's two parts.
	assert.equal(deriveColumns({ name: 'Ada Byron' }, ['name'], prev).name, 'Ada Byron');
	assert.equal(deriveColumns({}, ['name'], prev).name, null);
	assert.equal(deriveColumns({ familyName: 'Byron' }, ['givenName'], {}, SCHEMA).name, 'Byron');
	assert.equal(deriveColumns({}, ['givenName', 'familyName'], {}, SCHEMA).name, null);
});

test('R6: name is not a generated column', () => {
	assert.doesNotMatch(read('src/lib/server/migrations.ts'), /\bname\b[^,\n]*GENERATED/i);
});

// ---------------------------------------------------------------------------
// 10: every mutation is audited in the transaction, private values redacted
// ---------------------------------------------------------------------------

test('R10: an update audits the change with a private value reduced to set/empty', async () => {
	await update({ patch: { phone: '555 0100', bio: 'ada' } });
	const a = auditRow();
	assert.equal(a.action, 'member.updated');
	assert.equal(a.targetId, MEMBER_ID);
	assert.doesNotMatch(JSON.stringify(a), /555 0100|7946/);
	assert.deepEqual(a.before, { phone: '<set>', bio: '' });
	assert.deepEqual(a.after, { phone: '<set>', bio: 'ada' });
	assert.deepEqual(a.meta, { redacted: ['phone'] });
});

test('R10: a create takes the group lock and audits the new member, private values redacted', async () => {
	const id = await createMemberIn(client, {
		group: GROUP,
		actor: ADMIN,
		recordPrivateValues: false,
		email: 'nomi@example.org',
		values: { name: 'Nomi Vance', city: 'Lisbon', bio: '  ', phone: '555 0100' },
		meta: { requestId: 'r1' }
	});
	assert.equal(id, MEMBER_ID);
	assert.deepEqual(kinds(), ['lock', 'INSERT INTO member', 'audit']);
	const insert = log[1].values;
	assert.deepEqual(insert.slice(1, 5), ['nomi@example.org', 'Nomi Vance', 'Lisbon', null]);
	assert.deepEqual(JSON.parse(insert[5] as string), { name: 'Nomi Vance', city: 'Lisbon' });
	assert.deepEqual(JSON.parse(insert[6] as string), { phone: '555 0100' });
	const a = auditRow();
	assert.equal(a.category, 'membership');
	assert.equal(a.action, 'member.created');
	assert.doesNotMatch(JSON.stringify(a.after), /555 0100/);
	assert.deepEqual(a.meta, { requestId: 'r1', redacted: ['phone'] });
});

test('R10: a soft remove locks, reads FOR UPDATE, sets status and audits', async () => {
	assert.equal(
		await softRemoveMemberIn(client, { group: GROUP, actor: ADMIN, memberId: MEMBER_ID }),
		true
	);
	assert.deepEqual(kinds(), ['lock', 'select', 'UPDATE member SET', 'audit']);
	assert.match(log[2].text, /SET status = 'removed'/);
	assert.equal(auditRow().action, 'member.removed');
	log = [];
	row = null;
	assert.equal(
		await softRemoveMemberIn(client, { group: GROUP, actor: ADMIN, memberId: MEMBER_ID }),
		false
	);
	assert.deepEqual(kinds(), ['lock', 'select']);
});

test('R10: a hard purge locks, deletes and audits; a second purge writes nothing', async () => {
	assert.equal(
		await hardPurgeMemberIn(client, { group: GROUP, actor: ADMIN, memberId: MEMBER_ID }),
		true
	);
	assert.deepEqual(kinds(), ['lock', 'DELETE FROM member', 'audit']);
	assert.equal(auditRow().action, 'member.deleted');
	log = [];
	row = null;
	assert.equal(
		await hardPurgeMemberIn(client, { group: GROUP, actor: ADMIN, memberId: MEMBER_ID }),
		false
	);
	assert.deepEqual(kinds(), ['lock', 'DELETE FROM member']);
});

// ---------------------------------------------------------------------------
// 12: the readme
// ---------------------------------------------------------------------------

test('R12: docs/features.md says profile saves go to Postgres alone, and no longer that the sheet holds profiles', () => {
	const readme = read('docs/features.md');
	const bullet = readme.split('- **Profile editing**')[1]?.split(/\n- \*\*|\n#/)[0] ?? '';
	assert.match(bullet, /member-write/);
	assert.doesNotMatch(bullet, /sheet/i);
	assert.doesNotMatch(readme, /force a sync/);
	assert.doesNotMatch(readme, /single source of truth for profile/i);
	assert.doesNotMatch(readme, /written back to the source Sheet/);
	const requests = readme.split(/^## Membership requests$/m)[1]?.split(/^## /m)[0] ?? '';
	assert.doesNotMatch(requests, /the way\s+a sync maps a sheet row/);
	assert.match(requests, /member\.created/);
});
