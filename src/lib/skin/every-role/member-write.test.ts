import assert from 'node:assert/strict';
import { beforeEach, test, mock } from 'node:test';
import type { Client, UpdateInput } from '../../server/member-write-core';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// The member write path where it meets a field kind the default skin has none
// of: a checkbox, an avatar-role field, an email-role field and a name in two
// parts. The rest of the path is in src/lib/server/member-write.test.ts.

const { AUDIT_INSERT_SQL } = await import('../../server/audit-core');
const {
	GROUP_LOCK_SQL,
	MemberWriteError,
	SELECT_FOR_UPDATE_SQL,
	UPDATE_SQL,
	createMemberIn,
	updateMemberIn,
	validatePatch
} = await import('../../server/member-write-core');

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
		if (text === SELECT_FOR_UPDATE_SQL) {
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
		data: { givenName: 'Ada', familyName: 'Byron', staff: 'TRUE', publicProfile: 'TRUE' },
		private_data: { phone: '+44 20 7946 0000' },
		name: 'Ada Byron',
		city: null
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
	const [category, action, , , , , , , , , after, meta] = hits[0].values;
	const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
	return { category, action, after: j(after), meta: j(meta) };
}

test('R2: a patch that changes nothing stops after the read and writes nothing', async () => {
	assert.equal(await update({ patch: { givenName: 'Ada', staff: true, volunteer: false } }), 0);
	assert.deepEqual(kinds(), ['lock', 'select']);
});

test('R3: an affiliation checkbox goes out in the same UPDATE as the text fields', async () => {
	await update({ patch: { handle: 'ada', volunteer: true } });
	const updates = log.filter((s) => s.text === UPDATE_SQL);
	assert.equal(updates.length, 1);
	const data = JSON.parse(updates[0].values[2] as string);
	assert.equal(data.handle, 'ada');
	assert.equal(data.volunteer, 'TRUE');
});

test('R4: a form cannot write a field no form shows, nor give a checkbox text', () => {
	const opts = { writer: 'form' as const, mayWritePrivate: true };
	for (const patch of [
		{ email: 'x@example.org' },
		{ photo: 'u' },
		{ legacyAccess: 'y' },
		{ 'x.Team': 't' }
	]) {
		assert.throws(
			() => validatePatch(patch as unknown as Record<string, string>, opts),
			(e: unknown) => (e as InstanceType<typeof MemberWriteError>).status === 400
		);
	}
	assert.throws(() => validatePatch({ staff: 'TRUE' }, opts), /wrong type/);
	assert.doesNotThrow(() => validatePatch({ photo: 'u' }, { ...opts, allow: ['photo'] }));
});

test('R5: the avatar write of the private photo URL meets the same rule', async () => {
	const avatar = { writer: 'form' as const, allow: ['photo'], patch: { photo: 'https://x/a/1' } };
	await assert.rejects(
		() => update({ ...avatar, actor: STRANGER, authority: { admin: false } }),
		(e: unknown) => e instanceof MemberWriteError && e.status === 403
	);
	assert.deepEqual(kinds(), ['lock', 'select']);
	log = [];
	assert.equal(await update({ ...avatar, actor: SELF, authority: { admin: false } }), 1);
	assert.deepEqual(kinds(), ['lock', 'select', 'update', 'audit']);
});

test('R6: name is the given and family name fields joined, and cannot be written directly', async () => {
	assert.throws(
		() => validatePatch({ name: 'X' }, { writer: 'system', mayWritePrivate: true }),
		/unknown field "name"/
	);
	await update({ patch: { givenName: 'Augusta', city: 'London', website: 'https://l/ada' } });
	const [, , , , name, city] = log.find((s) => s.text === UPDATE_SQL)!.values;
	assert.deepEqual([name, city], ['Augusta Byron', 'London']);
});

test('R10: a create takes the group lock and audits the new member, private values redacted', async () => {
	const id = await createMemberIn(client, {
		group: GROUP,
		actor: ADMIN,
		recordPrivateValues: false,
		email: 'nomi@example.org',
		values: {
			givenName: 'Nomi',
			familyName: 'Vance',
			email: 'nomi@example.org',
			staff: true,
			volunteer: false
		},
		meta: { requestId: 'r1' }
	});
	assert.equal(id, MEMBER_ID);
	assert.deepEqual(kinds(), ['lock', 'INSERT INTO member', 'audit']);
	const insert = log[1].values;
	assert.equal(insert[2], 'Nomi Vance');
	assert.deepEqual(JSON.parse(insert[4] as string), {
		givenName: 'Nomi',
		familyName: 'Vance',
		staff: 'TRUE',
		volunteer: 'FALSE'
	});
	const a = auditRow();
	assert.equal(a.category, 'membership');
	assert.equal(a.action, 'member.created');
	assert.doesNotMatch(JSON.stringify(a.after), /nomi@example\.org/);
	assert.deepEqual(a.meta, { requestId: 'r1', redacted: ['email'] });
});
