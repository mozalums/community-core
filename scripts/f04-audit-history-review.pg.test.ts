import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.AUDIT_TEST_DATABASE_URL });
const GROUP = {
  id: '', slug: 'f04-review-probe', name: 'F4 review',
  landingMd: null,
  status: 'active'
};
const EMAIL = 'native@example.org';
const USER = { id: 'u-native', email: EMAIL, subject: `email:${EMAIL}`, name: 'Native Member', image: '' };
let failMemberDelete = false;
type Outcome = { status?: number; data?: { error?: string; deleteError?: string }; location?: string };

mock.module('$lib/server/postgres', { namedExports: {
  pgPool: () => pool,
  query: (sql: string, values?: unknown[]) => {
    if (failMemberDelete && /^DELETE FROM member WHERE/.test(sql)) throw new Error('injected DB delete failure');
    return pool.query(sql, values);
  },
  withTransaction: async <T>(fn: (client: pg.PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  }
} });
mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false } });
mock.module('$lib/server/log', { namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } } });
mock.module('$lib/server/avatars', { namedExports: {
  emailMd5: (s: string) => s, ensureAvatarRows: async () => new Map(),
  avatarIdFor: async () => null, deleteAvatar: async () => {},
  getAvatarByEmail: async () => null, recordGravatar: async () => {}
} });
mock.module('$lib/server/session-store', { namedExports: {
  deleteSession: async () => {}, deleteUserSessions: async () => 0,
  SESSION_COOKIE_NAME: 'session', SESSION_COOKIE_OPTIONS: { path: '/' }
} });

const { migrate } = await import('../src/lib/server/migrations');
const { requestData, submitRequest, approveRequest } = await import('../src/lib/server/requests');
const { getMemberById } = await import('../src/lib/server/members');
const { actions } = await import('../src/routes/group/[slug]/members/[id]/edit/+page.server');

before(async () => {
  assert.ok(process.env.AUDIT_TEST_DATABASE_URL, 'use a disposable database');
  await migrate(pool);
  GROUP.id = (await pool.query('INSERT INTO "group" (slug, name) VALUES ($1, $2) RETURNING id', [GROUP.slug, GROUP.name])).rows[0].id;
});
beforeEach(async () => {
  failMemberDelete = false;
  await pool.query('DELETE FROM access_request WHERE group_id = $1', [GROUP.id]);
  await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
});
after(async () => {
  await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
  await pool.end();
});

async function approve() {
  const data = requestData(EMAIL, { firstName: 'Native', lastName: 'Member', linkedin: 'https://example.org/member' }, { publicProfile: false });
  const request = await submitRequest(GROUP, USER, data, 'Native Member');
  const approved = await approveRequest(GROUP, request.id, { actorSubject: 'email:admin@example.org' });
  assert.ok(approved?.memberId);
  return approved.memberId;
}

async function action(name: 'save' | 'delete', id: string): Promise<Outcome> {
  const url = new URL(`https://example.org/group/${GROUP.slug}/members/${id}/edit`);
  const body = new FormData();
  body.set('firstName', 'Edited');
  const event = {
    params: { slug: GROUP.slug, id }, locals: { user: USER }, url,
    request: new Request(url, { method: 'POST', body }),
    cookies: { get: () => undefined, delete: () => {} }
  };
  try { return await actions[name]!(event as never) as Outcome; }
  catch (e) {
    if ((e as Outcome).status === 303) return e as Outcome;
    throw e;
  }
}


async function memberAudits(id: string) {
  return (await pool.query("SELECT actor_subject, actor_email, target_email, before, after FROM audit_event WHERE target_id = $1 AND action <> 'member.created' ORDER BY at", [id])).rows;
}

async function rejectAuditFor(id: string) {
  assert.match(id, /^[a-f0-9-]+$/);
  await pool.query(`ALTER TABLE audit_event ADD CONSTRAINT f04_review_reject_member_audit CHECK (target_id IS DISTINCT FROM '${id}') NOT VALID`);
}

async function restoreAudit() {
  await pool.query('ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS f04_review_reject_member_audit');
}

test('BRANCH-REGRESSION: a profile save retains change history after leaving the Sheet', async () => {
  const data = requestData(EMAIL, { firstName: 'Native', lastName: 'Member', linkedin: 'https://example.org/member' }, { publicProfile: false });
  const { rows: [member] } = await pool.query('INSERT INTO member (group_id, email, name, data, status) VALUES ($1, $2, $3, $4, $5) RETURNING id', [GROUP.id, EMAIL, 'Native Member', data, 'active']);
  const out = await action('save', member.id);
  assert.equal(out.status, 303, JSON.stringify(out));
  assert.equal((await getMemberById(GROUP.id, member.id))?.data.firstName, 'Edited');
  const events = await memberAudits(member.id);
  assert.equal(events.length, 1, 'successful profile save wrote neither Sheet history nor an audit event');
  assert.equal(events[0].actor_subject, USER.subject);
  assert.equal(events[0].actor_email, EMAIL);
  assert.equal(events[0].target_email, EMAIL);
  assert.match(JSON.stringify(events[0].before), /Native/);
  assert.match(JSON.stringify(events[0].after), /Edited/);
});

test('BRANCH-REGRESSION: native profile deletion leaves a durable actor and target', async () => {
  const id = await approve();
  const out = await action('delete', id);
  assert.equal(out.status, 303, JSON.stringify(out));
  assert.equal(await getMemberById(GROUP.id, id), null);
  const events = await memberAudits(id);
  assert.equal(events.length, 1, 'successful native deletion left no durable audit event');
  assert.equal(events[0].actor_subject, USER.subject);
  assert.equal(events[0].actor_email, EMAIL);
  assert.equal(events[0].target_email, EMAIL);
});

test('BRANCH-REGRESSION: an audit failure rolls back the profile save', async () => {
  const id = await approve();
  await rejectAuditFor(id);
  try {
    const out = await action('save', id);
    const member = await getMemberById(GROUP.id, id);
    assert.ok(out.status !== 303 && member?.data.firstName === 'Native', `reported ${out.status}, persisted First Name: ${member?.data.firstName}`);
  } finally { await restoreAudit(); }
});

test('BRANCH-REGRESSION: an audit failure rolls back profile deletion', async () => {
  const id = await approve();
  await rejectAuditFor(id);
  try {
    const out = await action('delete', id);
    const remains = await getMemberById(GROUP.id, id);
    assert.ok(out.status !== 303 && remains !== null, `reported ${out.status}, member retained: ${Boolean(remains)}`);
  } finally { await restoreAudit(); }
});
