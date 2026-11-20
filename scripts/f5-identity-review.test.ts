import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

type Statement = { sql: string; values: unknown[] };
const statements: Statement[] = [];
const groupId = '00000000-0000-4000-8000-000000000001';
const memberId = '00000000-0000-4000-8000-000000000002';
const email = 'member@example.org';
const subject = 'oidc:member';
const row = { id: memberId, group_id: groupId, email, ident_subject: null,
  name: 'Member', data: {}, private_data: {}, status: 'active' };
async function query(sql: string, values: unknown[] = []) {
  statements.push({ sql, values });
  if (/FROM member/.test(sql) && /ident_subject = \$2/.test(sql)) return { rows: [], rowCount: 0 };
  if (/SELECT/.test(sql) && /FROM member/.test(sql)) return { rows: [{ ...row }], rowCount: 1 };
  return { rows: [], rowCount: 1 };
}
mock.module('$lib/server/postgres', { namedExports: {
  query,
  withTransaction: async (fn: (client: { query: typeof query }) => Promise<unknown>) => {
    await query('BEGIN');
    try { const result = await fn({ query }); await query('COMMIT'); return result; }
    catch (error) { await query('ROLLBACK'); throw error; }
  }
} });
mock.module('$lib/server/avatars', { namedExports: {
  emailMd5: (value: string) => value, ensureAvatarRows: async () => new Map()
} });
mock.module('$lib/server/log', { namedExports: {
  log: { debug() {}, info() {}, warn() {}, error() {} }
} });
const { resolveMember } = await import('../src/lib/server/members');

test('review R10: binding a member identity commits its audit with the mutation', async () => {
  const result = await resolveMember(groupId, email, subject);
  assert.equal(result.firstLogin, true);
  const sql = statements.map(s => s.sql);
  const mutation = sql.findIndex(s => /UPDATE member/.test(s));
  const audit = sql.findIndex(s => /INSERT INTO audit_event/.test(s));
  assert.ok(mutation >= 0);
  assert.ok(audit > mutation, `member binding has no audit: ${JSON.stringify(sql)}`);
  assert.ok(sql.indexOf('BEGIN') >= 0 && sql.indexOf('BEGIN') < mutation);
  assert.ok(sql.indexOf('COMMIT') > audit);
});
