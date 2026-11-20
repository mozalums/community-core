import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
const require = createRequire(resolve('package.json'));
const pg = require('pg');
const moduleAt = (name: string) => import(pathToFileURL(resolve('src/lib/server', name)).href);
const { migrate } = await moduleAt('migrations.ts');
const { previewImport, applyImportPlan, runImport, loadRoster } = await moduleAt('member-import.ts');
const { formatCsv } = await moduleAt('csv-core.ts');
const { parseImport, diffImport, diffDigest, previewView } = await moduleAt('import-core.ts');
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
  // The stored Email clearing tests need an email-role field, which the default
  // skin does not declare: src/lib/skin/every-role/f07-import-state-markers.pg.test.ts.
  test(`R2/R14 control: ${channel} nested object keys and exact numbers survive edits with complete audit field evidence`, opts, async () => {
    const g = await fixture(`f7-r4-kinds-${channel}`);
    const values = ['true', '"true"', '42', '"42"', '{"toJSON":"data","toString":null,"valueOf":false,"n":[9007199254740993]}', '[{"toString":1,"valueOf":2,"__proto__":3},9007199254740995]', '"json:true"', '""'];
    for (const raw of values) {
      const result = await applyText(g, formatCsv([['Email','Name','Bio','Phone'],[g.email,'json:'+raw,'json:'+raw,'json:'+raw]]), channel);
      assert.equal(result.ok, true, JSON.stringify(result));
      const after = (await pool.query('SELECT data, data->\'bio\' = $2::jsonb AS exact FROM member WHERE group_id=$1', [g.id, raw])).rows[0];
      assert.equal(raw === '""' ? !Object.hasOwn(after.data, 'bio') : after.exact, true);
      const audit = (await pool.query("SELECT before, after, meta FROM audit_event WHERE run_id=$1 AND action='member.import-updated'", [result.runId])).rows[0];
      for (const key of ['name','bio','phone']) assert.ok(Object.hasOwn(audit.before,key) && Object.hasOwn(audit.after,key), JSON.stringify(audit));
      assert.notEqual(audit.before.bio,audit.after.bio);
      assert.equal(audit.after.phone,raw === '""' ? '<empty>' : '<set>');
      assert.deepEqual(audit.meta.redacted,['phone']);
    }
  });
}
test('R7: a preview of an inactive member refuses after another import reactivates that member at the same roster count', opts, async () => {
  const g = await fixture('f7-r4-status-drift', '{"bio":"old"}', '{}', 'removed');
  await pool.query('INSERT INTO member (group_id,email) VALUES ($1,$2)', [g.id,'peer@example.com']);
  const text = formatCsv([['Email','Bio'],[g.email,'replacement']]);
  const p = await tx(c => previewImport(c,g,actor,{text,mode:'merge',confirmPercent:10}));
  assert.ok(p.ok && p.planId);
  assert.equal(previewView(p.diff).changed[0].inactive,true);
  const swapped = await tx(c => runImport(c,g,actor,{
    text:formatCsv([['Email','Status'],[g.email,'active'],['peer@example.com','removed']]),
    mode:'replace',apply:true,confirmRemovals:1,recordPrivateValues:false
  }));
  assert.equal(swapped.ok,true,JSON.stringify(swapped));
  const roster = await tx(c => loadRoster(c,g.id,{forUpdate:false}));
  const diff = diffImport(parseImport(text,{mode:'merge'}),roster,'merge');
  assert.equal(previewView(diff).changed[0].inactive,false);
  assert.equal(diff.active,p.diff.active);
  const result = await tx(c => applyImportPlan(c,g,actor,{planId:p.planId,digest:p.digest,typed:null,confirmPercent:10},{recordPrivateValues:false}));
  const after = (await pool.query('SELECT status,data FROM member WHERE group_id=$1 AND email=$2',[g.id,g.email])).rows[0];
  const audit = (await pool.query('SELECT action FROM audit_event WHERE run_id=$1',[p.planId])).rows;
  assert.equal(result.ok,false,JSON.stringify({beforeInactive:previewView(p.diff).changed[0].inactive,nowInactive:previewView(diff).changed[0].inactive,sameDigest:diffDigest(diff)===p.digest,result,after,audit}));
  assert.equal(after.data.bio,'old');
  assert.deepEqual(audit,[]);
});
