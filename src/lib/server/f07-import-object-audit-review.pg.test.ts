import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const require = createRequire(resolve('package.json'));
const pg = require('pg');
const moduleAt = (name: string) => import(pathToFileURL(resolve('src/lib/server', name)).href);
const { migrate } = await moduleAt('migrations.ts');
const { previewImport, applyImportPlan, runImport } = await moduleAt('member-import.ts');
const { formatCsv } = await moduleAt('csv-core.ts');
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url }) : null;
const actor = { actorSubject: 'review:f7:round3', actorEmail: 'review@example.com' };
type Fixture = { id: string; slug: string; email: string };
before(async () => { if (pool) await migrate(pool); });
after(async () => { await pool?.end(); });

async function tx(fn: (client: any) => Promise<any>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}

async function fixture(slug: string, data?: string, privateData = '{}'): Promise<Fixture> {
  await pool.query('DELETE FROM "group" WHERE slug = $1', [slug]);
  const { rows } = await pool.query('INSERT INTO "group" (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
  const g = { id: rows[0].id, slug, email: 'member@example.com' };
  if (data !== undefined) await pool.query(
    "INSERT INTO member (group_id, email, name, city, data, private_data) VALUES ($1, $2, 'legacy name', 'Old city', $3::jsonb, $4::jsonb)",
    [g.id, g.email, data, privateData]
  );
  return g;
}

async function applyText(g: Fixture, text: string, channel: 'admin' | 'cli') {
  if (channel === 'cli') return tx(c => runImport(c, g, actor, {
    text, mode: 'merge', apply: true, confirmRemovals: null, recordPrivateValues: false
  }));
  const p = await tx(c => previewImport(c, g, actor, { text, mode: 'merge', confirmPercent: 10 }));
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  return tx(c => applyImportPlan(c, g, actor, {
    planId: p.planId, digest: p.digest, typed: null, confirmPercent: 10
  }, { recordPrivateValues: false }));
}

for (const channel of ['admin', 'cli'] as const) {
  for (const operation of ['addition', 'edit'] as const) {
    test(`R2: ${channel} ${operation} accepts an object with an own toString data key`, opts, async () => {
      const g = await fixture(`f7-r3-object-${channel}-${operation}`, operation === 'edit' ? '{"name":"Old"}' : undefined);
      const value = '{"toString":"a stored value","nested":[9007199254740993]}';
      const result = await applyText(g, formatCsv([['Email', 'Name'], [g.email, 'json:' + value]]), channel);
      assert.equal(result.ok, true, JSON.stringify(result));
      const after = (await pool.query('SELECT name, data::text AS data, data->\'name\' = $2::jsonb AS exact FROM member WHERE group_id = $1', [g.id, value])).rows[0];
      assert.equal(after.exact, true, JSON.stringify(after));
      assert.equal(after.name, '[object Object]');
    });
  }
  test(`R2 control: ${channel} preserves nested exact numbers on addition, explicit edit and unrelated edit`, opts, async () => {
    const g = await fixture(`f7-r3-nested-${channel}`);
    for (const value of ['[9007199254740993,[1e400,null],{"n":9007199254740995}]', '[[9007199254740997],false]']) {
      const result = await applyText(g, formatCsv([['Email', 'Name'], [g.email, 'json:' + value]]), channel);
      assert.equal(result.ok, true, JSON.stringify(result));
      const after = (await pool.query('SELECT data->\'name\' = $2::jsonb AS exact FROM member WHERE group_id = $1', [g.id, value])).rows[0];
      assert.equal(after.exact, true);
    }
    await pool.query('UPDATE member SET private_data = $2::jsonb WHERE group_id = $1', [g.id, '{"x.Keep":{"n":[9007199254740999]}}']);
    const before = (await pool.query('SELECT name, data::text AS data, private_data::text AS private_data FROM member WHERE group_id = $1', [g.id])).rows[0];
    const result = await applyText(g, formatCsv([['Email', 'City'], [g.email, 'New city']]), channel);
    assert.equal(result.ok, true, JSON.stringify(result));
    const after = (await pool.query('SELECT name, city, data::text AS data, private_data::text AS private_data FROM member WHERE group_id = $1', [g.id])).rows[0];
    assert.equal(after.name, before.name);
    assert.equal(after.private_data, before.private_data);
    assert.equal(after.city, 'New city');
    assert.match(after.data, /9007199254740997/);
  });
}

test('R14: a public field type change retains the changed field and distinct values in the audit', opts, async () => {
  const g = await fixture('f7-r3-public-audit', '{"bio":true}');
  const result = await applyText(g, formatCsv([['Email', 'Bio'], [g.email, 'true']]), 'admin');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, 1);
  const after = (await pool.query('SELECT data FROM member WHERE group_id = $1', [g.id])).rows[0];
  assert.equal(after.data.bio, 'true');
  const audit = (await pool.query('SELECT action, before, after, meta FROM audit_event WHERE run_id = $1 ORDER BY action', [result.runId])).rows;
  assert.equal(audit.length, 2);
  const changed = audit.find((r: any) => r.action === 'member.import-updated');
  assert.ok(Object.hasOwn(changed.before, 'bio') && Object.hasOwn(changed.after, 'bio'), JSON.stringify({ after, audit }));
  assert.notEqual(changed.before.bio, changed.after.bio);
});

test('R14: a private field type change records its redacted field name and set markers', opts, async () => {
  const g = await fixture('f7-r3-private-audit', '{}', '{"phone":42}');
  const result = await applyText(g, formatCsv([['Email', 'Phone'], [g.email, '42']]), 'cli');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.diff.changed.length, 1);
  const after = (await pool.query('SELECT private_data FROM member WHERE group_id = $1', [g.id])).rows[0];
  assert.equal(after.private_data.phone, '42');
  const audit = (await pool.query("SELECT before, after, meta FROM audit_event WHERE run_id = $1 AND action = 'member.import-updated'", [result.runId])).rows[0];
  assert.deepEqual(audit, { before: { phone: '<set>' }, after: { phone: '<set>' }, meta: { redacted: ['phone'] } }, JSON.stringify({ after, audit }));
});
