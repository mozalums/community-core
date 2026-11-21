import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = (p: string) => pathToFileURL(resolve(p)).href;
assert.ok(process.env.AUDIT_TEST_DATABASE_URL, 'use a disposable database');
const url = new URL(process.env.AUDIT_TEST_DATABASE_URL!);
const env = { POSTGRES_HOST: url.hostname, POSTGRES_PORT: url.port,
  POSTGRES_DATABASE: url.pathname.slice(1), POSTGRES_USER: url.username,
  POSTGRES_PASSWORD: url.password, POSTGRES_SSL: 'false' };
registerHooks({ resolve(s,c,next) {
  if (s === '$env/dynamic/private') return { shortCircuit: true,
    url: 'data:text/javascript,export const env=' + encodeURIComponent(JSON.stringify(env)) };
  return next(s,c);
}});
const group = { id: '', slug: 'e32-pool-review', name: 'Pool review' };
const admin = { email: 'admin@example.org', subject: 'email:admin@example.org' };
const errors: string[] = [];
mock.module('$lib/server/groups', { namedExports: {
  getGroupBySlug: async () => group, resolveGroupAdmin: async () => true
}});
mock.module('$lib/server/session-store', { namedExports: {
  SESSION_COOKIE_NAME: 'sid', SESSION_COOKIE_OPTIONS: {},
  deleteUserSessions: async () => 0, deleteSession: async () => {}
}});
mock.module('$lib/server/log', { namedExports: { log: {
  debug() {}, info() {}, warn() {}, error(_name: string, data: any) { errors.push(data.error?.message); }
}}});
const { pgPool, closePool } = await import(source('src/lib/server/postgres.ts'));
const { migrate } = await import(source('src/lib/server/migrations.ts'));
const { hardPurgeMember } = await import(source('src/lib/server/member-write.ts'));
const { putAvatar } = await import(source('src/lib/server/avatars.ts'));
const { actions } = await import(source('src/routes/group/[slug]/removal/[id]/+page.server.ts'));
after(async () => { await closePool(); });
test('E32 R6: independent pending removals complete with the production pool and real avatar store', async () => {
  const pool = pgPool();
  await migrate(pool);
  group.id = (await pool.query('INSERT INTO "group" (slug,name) VALUES ($1,$2) RETURNING id', [group.slug,group.name])).rows[0].id;
  const ids: string[] = [];
  for (let n=0; n<5; n++) {
    const email = `member${n}@example.org`;
    const id = (await pool.query('INSERT INTO member (group_id,email,name,ident_subject) VALUES ($1,$2,$3,$4) RETURNING id',
      [group.id,email,'Member',`email:${email}`])).rows[0].id;
    await putAvatar(email,Buffer.from('photo'),'image/png');
    await hardPurgeMember(group,id,{actorEmail:admin.email,actorSubject:admin.subject});
    ids.push(id);
  }
  await pool.query(`CREATE FUNCTION e32_overlap_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action = 'member.removal-completed' THEN PERFORM pg_sleep(0.2); END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE TRIGGER e32_overlap_completion BEFORE INSERT ON audit_event
    FOR EACH ROW EXECUTE FUNCTION e32_overlap_completion()`);
  const start = Date.now();
  const results = await Promise.all(ids.map(async id => {
    const url = new URL(`https://example.org/removal/${id}`);
    try { return await actions.default({ params:{slug:group.slug,id}, locals:{user:admin}, url,
      cookies:{get:()=>undefined,delete(){}} } as never); }
    catch(e) { return e; }
  }));
  const remaining = (await pool.query('SELECT count(*)::int AS n FROM member_avatar')).rows[0].n;
  const completions = (await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action='member.removal-completed'")).rows[0].n;
  const statuses = results.map((r:any)=>r.status);
  console.log(JSON.stringify({max:pool.options.max,elapsedMs:Date.now()-start,statuses,remaining,completions,errors}));
  assert.deepEqual(statuses,[303,303,303,303,303], 'healthy concurrent removals exhausted their own shared pool');
  assert.equal(remaining,0);
  assert.equal(completions,5);
});
