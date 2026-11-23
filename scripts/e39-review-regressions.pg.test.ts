import assert from 'node:assert/strict';
import { before, after, test, mock } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/lib/server/migrations';
import { auditIn } from '../src/lib/server/audit-core';

const url = process.env.AUDIT_TEST_DATABASE_URL;
assert.ok(url, 'Use a throwaway Postgres database');
const pool = new pg.Pool({ connectionString: url });
mock.module('$lib/server/postgres', { namedExports: {
  query: (sql: string, values?: unknown[]) => pool.query(sql, values),
  withTransaction: async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
} });
let envAdmins: string[] = [];
mock.module('$lib/server/admin', { namedExports: { isAdmin: (subject: string) => envAdmins.includes(subject) } });
mock.module('$lib/server/members', { namedExports: { resolveMember: async () => ({ member: null, firstLogin: false }) } });
mock.module('$lib/server/audit', { namedExports: {
  auditIn,
  actorOf: (user: { subject: string; email: string }) => ({ actorSubject: user.subject, actorEmail: user.email })
} });
const { actions } = await import('../src/routes/group/[slug]/admin/access/+page.server');
before(() => migrate(pool));
after(() => pool.end());

test('R5: two concurrent revokes retain an administrator', async () => {
  const group = (await pool.query(`INSERT INTO "group" (slug, name) VALUES ('e39-review-race', 'Race') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id, slug`)).rows[0];
  const subjects = ['email:a@example.com', 'email:b@example.com'];
  try {
    for (const subject of subjects) await pool.query(`INSERT INTO group_admin (group_id, ident_subject, email) VALUES ($1, $2, $3)`, [group.id, subject, subject.slice(6)]);
    const pending: (() => void)[] = [];
    const post = async (actor: string, target: string) => {
      const form = new FormData();
      form.set('subject', target);
      return actions.revoke({
        params: { slug: group.slug },
        locals: { user: { id: actor, subject: actor, email: actor.slice(6), name: actor, image: '' } },
        request: { formData: async () => {
          await new Promise<void>((resolve) => { pending.push(resolve); if (pending.length === 2) pending.forEach((done) => done()); });
          return form;
        } }
      } as never);
    };
    const outcomes = await Promise.allSettled([post(subjects[0], subjects[1]), post(subjects[1], subjects[0])]);
    const remaining = (await pool.query('SELECT ident_subject FROM group_admin WHERE group_id = $1', [group.id])).rows;
    assert.ok(remaining.length >= 1, JSON.stringify({ remaining, outcomes }));
  } finally { await pool.query('DELETE FROM "group" WHERE id = $1', [group.id]); }
});


test('revoking a seeded env grant does not claim global access ended', async () => {
  const group = (await pool.query(`INSERT INTO "group" (slug, name) VALUES ('e39-review-env', 'Env') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id, slug`)).rows[0];
  const actor = 'email:actor@example.com';
  const target = 'email:global@example.com';
  envAdmins = [target];
  try {
    for (const subject of [actor, target]) await pool.query(`INSERT INTO group_admin (group_id, ident_subject) VALUES ($1, $2)`, [group.id, subject]);
    const form = new FormData();
    form.set('subject', target);
    const result = await actions.revoke({
      params: { slug: group.slug },
      locals: { user: { id: actor, subject: actor, email: actor.slice(6), name: '', image: '' } },
      request: new Request('http://localhost/admin/access?/revoke', { method: 'POST', body: form })
    } as never) as { message: string };
    const { isGroupAdmin } = await import('../src/lib/server/groups');
    assert.equal(await isGroupAdmin(group.id, target), true);
    assert.doesNotMatch(result.message, /is no longer an admin/, JSON.stringify(result));
  } finally {
    envAdmins = [];
    await pool.query('DELETE FROM "group" WHERE id = $1', [group.id]);
  }
});

