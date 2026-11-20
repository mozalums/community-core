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
  const data = requestData(GROUP, EMAIL, { firstName: 'Native', lastName: 'Member', linkedin: 'https://example.org/member' }, { 'Public Profile': false });
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

test('BRANCH-REGRESSION: a natively approved member can save their profile', async () => {
  const id = await approve();
  const out = await action('save', id);
  assert.equal(out.status, 303, JSON.stringify(out));
  assert.equal((await getMemberById(GROUP.id, id))?.data.firstName, 'Edited');
});

test('BRANCH-REGRESSION: a natively approved member can delete their profile', async () => {
  const id = await approve();
  const out = await action('delete', id);
  assert.equal(out.status, 303, JSON.stringify(out));
  assert.equal(await getMemberById(GROUP.id, id), null);
});

test('BRANCH-REGRESSION: deleting a profile cannot report success while Postgres retains access', async () => {
  const id = await approve();
  await pool.query("INSERT INTO member (group_id, email, status) VALUES ($1, 'keeper@example.org', 'active')", [GROUP.id]);
  failMemberDelete = true;
  const out = await action('delete', id);
  failMemberDelete = false;
  const remains = await getMemberById(GROUP.id, id);
  assert.ok(out.status !== 303 || remains === null, `reported ${out.status}, active member remains: ${Boolean(remains)}`);
});
