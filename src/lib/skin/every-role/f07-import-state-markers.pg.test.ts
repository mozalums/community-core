import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test, mock } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// The import, which binds the field schema when it loads, on a field set
// with roles the default skin leaves out: a stored Email field beside the
// sign-in address, and a name joined from two fields. The first two tests
// moved here from src/lib/server/f07-import-state-markers-review.pg.test.ts,
// which runs the rest on the default skin.
const require = createRequire(resolve('package.json'));
const pg = require('pg');
const moduleAt = (name: string) => import(pathToFileURL(resolve('src/lib/server', name)).href);
const { migrate } = await moduleAt('migrations.ts');
const { previewImport, applyImportPlan, runImport } = await moduleAt('member-import.ts');
const { formatCsv } = await moduleAt('csv-core.ts');
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url }) : null;
const actor = { actorSubject: 'review:f7:round4', actorEmail: 'review@example.com' };
type Fixture = { id: string; slug: string; email: string };
before(async () => { if (pool) await migrate(pool); });
after(async () => { await pool?.end(); });
async function tx(fn: (client: any) => Promise<any>) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
  catch (error) { await c.query('ROLLBACK'); throw error; }
  finally { c.release(); }
}
async function fixture(slug: string, data = '{}', privateData = '{}', status = 'active'): Promise<Fixture> {
  await pool.query('DELETE FROM "group" WHERE slug = $1', [slug]);
  const { rows } = await pool.query('INSERT INTO "group" (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
  const g = { id: rows[0].id, slug, email: 'member@example.com' };
  await pool.query('INSERT INTO member (group_id, email, data, private_data, status) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)', [g.id,g.email,data,privateData,status]);
  return g;
}
async function applyText(g: Fixture, text: string, channel: 'admin' | 'cli') {
  if (channel === 'cli') return tx(c => runImport(c, g, actor, { text, mode: 'merge', apply: true, confirmRemovals: null, recordPrivateValues: false }));
  const p = await tx(c => previewImport(c, g, actor, { text, mode: 'merge', confirmPercent: 10 }));
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  return tx(c => applyImportPlan(c, g, actor, { planId: p.planId, digest: p.digest, typed: null, confirmPercent: 10 }, { recordPrivateValues: false }));
}
for (const channel of ['admin', 'cli'] as const) {
  test(`R14: ${channel} stored Email clearing retains set/empty markers in the persisted event`, opts, async () => {
    const g = await fixture(`every-role-email-${channel}`, '{}', '{"email":"old@example.com"}');
    const result = await applyText(g, formatCsv([['Email', 'Email (stored)'], [g.email, '']]), channel);
    assert.equal(result.ok, true, JSON.stringify(result));
    const member = (await pool.query('SELECT email::text AS email, private_data FROM member WHERE group_id=$1', [g.id])).rows[0];
    assert.deepEqual(member, {email:g.email, private_data:{}});
    const audit = (await pool.query("SELECT before, after, meta FROM audit_event WHERE run_id=$1 AND action='member.import-updated'", [result.runId])).rows[0];
    assert.deepEqual(audit, {before:{email:'<set>'},after:{email:'<empty>'},meta:{redacted:['email']}}, JSON.stringify({member,audit}));
  });
  test(`every-role: ${channel} import joins the name column from both name fields, each read by JSON kind`, opts, async () => {
    const g = await fixture(`every-role-name-${channel}`, '{"givenName":"Old"}');
    const text = formatCsv([['Email','Given name','Family name'],[g.email,'json:[{"valueOf":"x"},1]','json:{"toString":1,"valueOf":{}}']]);
    const result = await applyText(g, text, channel);
    assert.equal(result.ok, true, JSON.stringify(result));
    const member = (await pool.query('SELECT name FROM member WHERE group_id=$1', [g.id])).rows[0];
    assert.equal(member.name, '[object Object],1 [object Object]');
    const audit = (await pool.query("SELECT before, after FROM audit_event WHERE run_id=$1 AND action='member.import-updated'", [result.runId])).rows[0];
    assert.deepEqual(audit, {
      before: { givenName: 'Old', familyName: '' },
      after: { givenName: 'json:[{"valueOf":"x"},1]', familyName: 'json:{"toString":1,"valueOf":{}}' }
    });
  });
}
