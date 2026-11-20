import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const require = createRequire(resolve('package.json'));
const pg = require('pg');
const moduleAt = (name: string) => import(pathToFileURL(resolve('src/lib/server', name)).href);
const { migrate } = await moduleAt('migrations.ts');
const { previewImport, applyImportPlan, loadRoster, lockRosterShared } = await moduleAt('member-import.ts');
const { parseImport, diffImport, diffDigest, previewView } = await moduleAt('import-core.ts');
const { formatCsv } = await moduleAt('csv-core.ts');
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url }) : null;
const actor = { actorSubject: 'review:f7:round2', actorEmail: 'review@example.com' };
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
async function fixture(slug: string, data: string): Promise<Fixture> {
  await pool.query('DELETE FROM "group" WHERE slug = $1', [slug]);
  const { rows } = await pool.query('INSERT INTO "group" (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
  const g = { id: rows[0].id, slug, email: 'member@example.com' };
  await pool.query("INSERT INTO member (group_id, email, name, city, data) VALUES ($1, $2, 'legacy name', 'Old city', $3::jsonb)", [g.id, g.email, data]);
  return g;
}
const preview = (g: Fixture, text: string) => tx(c => previewImport(c, g, actor, { text, mode: 'merge', confirmPercent: 10 }));
const apply = (g: Fixture, p: any) => tx(c => applyImportPlan(c, g, actor, { planId: p.planId, digest: p.digest, typed: null, confirmPercent: 10 }, { recordPrivateValues: false }));

test('R2: a City-only edit preserves an absent First Name containing an exact-number array', opts, async () => {
  const g = await fixture('f7-review2-array-untouched', '{"name":[9007199254740993],"city":"Old city"}');
  const before = (await pool.query('SELECT data::text AS data, name FROM member WHERE group_id = $1', [g.id])).rows[0];
  const p = await preview(g, formatCsv([['Email', 'City'], [g.email, 'New city']]));
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  assert.deepEqual(p.diff.changed[0].changes.map((c: any) => c.key), ['city']);
  const result = await apply(g, p);
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = (await pool.query('SELECT data::text AS data, name, city FROM member WHERE group_id = $1', [g.id])).rows[0];
  assert.equal(after.name, before.name);
  assert.equal(after.city, 'New city');
  assert.match(after.data, /"name": \[9007199254740993\]/);
});

test('R2: an explicitly edited First Name array applies without rounding its numbers', opts, async () => {
  const g = await fixture('f7-review2-array-edited', '{"name":"Old name"}');
  const p = await preview(g, formatCsv([['Email', 'Name'], [g.email, 'json:[9007199254740993]']]));
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  const result = await apply(g, p);
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = (await pool.query('SELECT data::text AS data, name FROM member WHERE group_id = $1', [g.id])).rows[0];
  assert.match(after.data, /"name": \[9007199254740993\]/);
  assert.match(after.name, /9007199254740993/);
});

test('R7: a type change in a displayed before-value invalidates the preview and writes nothing', opts, async () => {
  const g = await fixture('f7-review2-digest-type', '{"bio":true}');
  const text = formatCsv([['Email', 'Bio'], [g.email, 'replacement']]);
  const p = await preview(g, text);
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  await tx(async c => {
    await lockRosterShared(c, g.id);
    await c.query('UPDATE member SET data = $2::jsonb WHERE group_id = $1', [g.id, '{"bio":"true"}']);
  });
  const current = await tx(c => loadRoster(c, g.id, { forUpdate: false }));
  const recomputed = diffImport(parseImport(text, { mode: 'merge' }), current, 'merge');
  const beforeOnScreen = previewView(p.diff).changed[0].fields[0].before;
  const beforeNow = previewView(recomputed).changed[0].fields[0].before;
  assert.notEqual(beforeOnScreen, beforeNow);
  const result = await apply(g, p);
  const after = (await pool.query('SELECT data FROM member WHERE group_id = $1', [g.id])).rows[0];
  const audit = (await pool.query('SELECT action FROM audit_event WHERE run_id = $1', [p.planId])).rows;
  assert.equal(result.ok, false, JSON.stringify({ beforeOnScreen, beforeNow, sameDigest: p.digest === diffDigest(recomputed), result, after, audit }));
  assert.deepEqual(after.data, { bio: 'true' });
  assert.deepEqual(audit, []);
});
