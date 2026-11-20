import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

const require = createRequire(resolve('package.json'));
const pg = require('pg');
const moduleAt = (name: string) => import(pathToFileURL(resolve('src/lib/server', name)).href);
const { migrate } = await moduleAt('migrations.ts');
const { previewImport, applyImportPlan } = await moduleAt('member-import.ts');
const { formatCsv } = await moduleAt('csv-core.ts');
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url }) : null;
const actor = { actorSubject: 'review:f7', actorEmail: 'review@example.com' };
type Fixture = { id: string; slug: string; emails: string[] };

before(async () => { if (pool) await migrate(pool); });
after(async () => { await pool?.end(); });

async function tx(fn: (client: any) => Promise<any>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}

async function fixture(slug: string, n: number, data: object = {}): Promise<Fixture> {
  await pool.query('DELETE FROM "group" WHERE slug = $1', [slug]);
  const { rows } = await pool.query('INSERT INTO "group" (slug, name) VALUES ($1, $1) RETURNING id', [slug]);
  const emails = Array.from({ length: n }, (_, i) => `m${i}@example.com`);
  for (const email of emails) {
    await pool.query('INSERT INTO member (group_id, email, data) VALUES ($1, $2, $3::jsonb)', [rows[0].id, email, JSON.stringify(data)]);
  }
  return { id: rows[0].id, slug, emails };
}

const preview = (g: Fixture, text: string, mode = 'merge') => tx(c => previewImport(c, g, actor, { text, mode, confirmPercent: 10 }));
const apply = (g: Fixture, p: any) => tx(c => applyImportPlan(c, g, actor, { planId: p.planId, digest: p.digest, typed: null, confirmPercent: 10 }, { recordPrivateValues: false }));

test('R3: an explicit all-empty CSV record is a blank-email error, never a removal', opts, async () => {
  const g = await fixture('f7-review-blank', 20);
  const text = formatCsv([['Email', 'City'], ...g.emails.map((email, i) => i === 9 ? ['', ''] : [email, ''])]);
  const p = await preview(g, text, 'replace');
  let result;
  if (p.ok && p.planId) result = await apply(g, p);
  const { rows } = await pool.query("SELECT email::text AS email FROM member WHERE group_id = $1 AND status = 'removed'", [g.id]);
  assert.equal(p.ok, false, JSON.stringify({ previewAccepted: p.ok, gate: p.gate, apply: result, removed: rows }));
  assert.match(p.errors.join('\n'), /row 11/);
  assert.deepEqual(rows, []);
});

test('R7: JSONB plan persistence must not change the preview digest for a structured value', opts, async () => {
  const g = await fixture('f7-review-plan-order', 1, { bio: 'old' });
  const p = await preview(g, formatCsv([['Email', 'Bio'], [g.emails[0], 'json:{"z":1,"a":2}']]));
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  const result = await apply(g, p);
  assert.equal(result.ok, true, JSON.stringify(result));
  const { rows } = await pool.query('SELECT data FROM member WHERE group_id = $1', [g.id]);
  assert.deepEqual(rows[0].data.bio, { a: 2, z: 1 });
});

test('R2: editing Bio preserves an absent numeric First Name and applies successfully', opts, async () => {
  const g = await fixture('f7-review-number', 1, { firstName: 42, bio: 'old' });
  const p = await preview(g, formatCsv([['Email', 'Bio'], [g.emails[0], 'new']]));
  assert.ok(p.ok && p.planId, JSON.stringify(p));
  const result = await apply(g, p);
  assert.equal(result.ok, true, JSON.stringify(result));
  const { rows } = await pool.query('SELECT data::text AS data FROM member WHERE group_id = $1', [g.id]);
  assert.deepEqual(JSON.parse(rows[0].data), { firstName: 42, bio: 'new' });
});
