import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

// Profile save and member deletion write Postgres alone, so each one's audit
// row is the only record of who changed or removed a member. Driven against a
// client that logs statements and transaction boundaries, so "on the
// mutation's own transaction, before COMMIT" is asserted rather than assumed.
// The real-Postgres rollback cases live in member-edit.pg.test.ts.

type Stmt = { text: string; values: unknown[]; inTx: boolean };
const log: Stmt[] = [];
let inTx = false;
let memberRow: Record<string, unknown> | null = null;
let auditFails = false;

const client = {
	query: async (text: string, values: unknown[] = []) => {
		log.push({ text, values, inTx });
		if (/INSERT INTO audit_event/.test(text) && auditFails) throw new Error('audit rejected');
		if (/^\s*(SELECT|DELETE)[\s\S]*FROM member/.test(text)) {
			return { rows: memberRow ? [memberRow] : [], rowCount: memberRow ? 1 : 0 };
		}
		return { rows: [], rowCount: 1 };
	}
};

mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string, values: unknown[] = []) => {
			log.push({ text, values, inTx });
			return { rows: [], rowCount: 0 };
		},
		withTransaction: async (fn: (c: typeof client) => Promise<unknown>) => {
			inTx = true;
			log.push({ text: 'BEGIN', values: [], inTx });
			try {
				const out = await fn(client);
				log.push({ text: 'COMMIT', values: [], inTx });
				return out;
			} catch (e) {
				log.push({ text: 'ROLLBACK', values: [], inTx });
				throw e;
			} finally {
				inTx = false;
			}
		}
	}
});
mock.module('$lib/server/avatars', {
	namedExports: { emailMd5: (s: string) => s, ensureAvatarRows: async () => new Map() }
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { saveMemberProfile } = await import('./member-edit');
const { hardPurgeMember: deleteMember } = await import('./member-write');
const { AUDIT_INSERT_SQL } = await import('./audit-core');

const GROUP = {
	id: '00000000-0000-4000-8000-000000000001',
	slug: 'example',
	name: 'Example',
	landingMd: null,
	status: 'active'
};
const MEMBER = {
	id: '00000000-0000-4000-8000-0000000000aa',
	groupId: GROUP.id,
	email: 'ada@example.org',
	identSubject: 'oidc:ada',
	name: 'Ada Byron',
	city: null,
	data: {},
	status: 'active'
};
const ACTOR = { actorSubject: 'email:admin@example.org', actorEmail: 'admin@example.org' };
const NO_CHANGE = { checks: {}, other: '', publicProfile: true };
const ADMIN = { admin: true };

beforeEach(() => {
	log.length = 0;
	auditFails = false;
	memberRow = {
		email: MEMBER.email,
		ident_subject: MEMBER.identSubject,
		data: { name: 'Ada Byron' },
		private_data: {}
	};
});

const NAMES = [
	'category',
	'action',
	'actorSubject',
	'actorEmail',
	'groupId',
	'groupSlug',
	'targetEmail',
	'targetSubject',
	'targetId',
	'before',
	'after',
	'meta'
];
function audited(): Record<string, unknown> {
	const hits = log.filter((s) => s.text === AUDIT_INSERT_SQL);
	assert.equal(hits.length, 1, `expected one audit insert, got ${hits.length}`);
	assert.ok(hits[0].inTx, 'the audit row was written outside the transaction');
	const row = Object.fromEntries(NAMES.map((n, i) => [n, hits[0].values[i]]));
	for (const k of ['before', 'after', 'meta']) {
		if (typeof row[k] === 'string') row[k] = JSON.parse(row[k] as string);
	}
	return row;
}
function before(a: string, b: string): boolean {
	const texts = log.map((s) => s.text);
	const i = texts.findIndex((t) => t.includes(a));
	const j = texts.lastIndexOf(b);
	return i >= 0 && j > i;
}

test('a profile save audits actor, target and the changed fields before COMMIT', async () => {
	await saveMemberProfile(
		GROUP,
		MEMBER,
		{ ...NO_CHANGE, updates: { name: 'Augusta Byron' } },
		ACTOR,
		ADMIN
	);
	const e = audited();
	assert.equal(e.category, 'data');
	assert.equal(e.action, 'member.updated');
	assert.equal(e.actorSubject, ACTOR.actorSubject);
	assert.equal(e.actorEmail, ACTOR.actorEmail);
	assert.equal(e.targetEmail, MEMBER.email);
	assert.equal(e.targetSubject, MEMBER.identSubject);
	assert.equal(e.targetId, MEMBER.id);
	assert.deepEqual(e.before, { name: 'Ada Byron' });
	assert.deepEqual(e.after, { name: 'Augusta Byron' });
	assert.ok(before('UPDATE member', 'COMMIT'));
	assert.ok(before(AUDIT_INSERT_SQL, 'COMMIT'));
});

test('a private field is audited as set/empty, never as its value', async () => {
	await saveMemberProfile(
		GROUP,
		MEMBER,
		{ ...NO_CHANGE, updates: { phone: '555 0100' } },
		ACTOR,
		ADMIN
	);
	const e = audited();
	assert.doesNotMatch(JSON.stringify(e), /555 0100/);
	const [key] = Object.keys(e.after as object);
	assert.deepEqual(e.before, { [key]: '<empty>' });
	assert.deepEqual(e.after, { [key]: '<set>' });
	assert.deepEqual(e.meta, { redacted: [key] });
});

test('a save that changes nothing writes no audit row', async () => {
	await saveMemberProfile(
		GROUP,
		MEMBER,
		{ ...NO_CHANGE, updates: { name: 'Ada Byron' } },
		ACTOR,
		ADMIN
	);
	assert.equal(log.filter((s) => s.text === AUDIT_INSERT_SQL).length, 0);
});

test('a failing audit write fails the save and rolls it back', async () => {
	auditFails = true;
	await assert.rejects(() =>
		saveMemberProfile(GROUP, MEMBER, { ...NO_CHANGE, updates: { name: 'X' } }, ACTOR, ADMIN)
	);
	assert.equal(log.at(-1)?.text, 'ROLLBACK');
});

test('a deletion audits actor and target on the DELETE’s own transaction', async () => {
	assert.equal(await deleteMember(GROUP, MEMBER.id, ACTOR, 'email:ada@example.org'), true);
	const e = audited();
	assert.equal(e.category, 'membership');
	assert.equal(e.action, 'member.deleted');
	assert.equal(e.actorSubject, ACTOR.actorSubject);
	assert.equal(e.targetEmail, MEMBER.email);
	assert.equal(e.targetSubject, MEMBER.identSubject);
	assert.equal(e.targetId, MEMBER.id);
	assert.ok(before('DELETE FROM member', AUDIT_INSERT_SQL));
	assert.ok(before(AUDIT_INSERT_SQL, 'COMMIT'));
	const stars = log.findIndex((s) => s.text.includes('member_star'));
	assert.ok(stars > log.findIndex((s) => s.text === 'COMMIT'), 'star cleanup ran before commit');
});

test('a failing audit write fails the deletion and rolls it back', async () => {
	auditFails = true;
	await assert.rejects(() => deleteMember(GROUP, MEMBER.id, ACTOR));
	assert.equal(log.at(-1)?.text, 'ROLLBACK');
});

test('a deletion that matches no row writes no audit row', async () => {
	memberRow = null;
	assert.equal(await deleteMember(GROUP, MEMBER.id, ACTOR), false);
	assert.equal(log.filter((s) => s.text === AUDIT_INSERT_SQL).length, 0);
});
