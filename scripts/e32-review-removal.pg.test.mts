import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const source = (p: string) => pathToFileURL(resolve(p)).href;
const { default: pg } = await import(source('node_modules/pg/lib/index.js'));
assert.ok(process.env.AUDIT_TEST_DATABASE_URL, 'use a disposable database');
const pool = new pg.Pool({ connectionString: process.env.AUDIT_TEST_DATABASE_URL });
const group = { id: '', slug: 'e32-review', name: 'Review' };
const user = { email: 'member@example.org', subject: 'email:member@example.org' };
const admin = { email: 'admin@example.org', subject: 'email:admin@example.org' };
let id = '';
let failAvatar = false;
let photo = true;
const sessions = new Set<string>();
mock.module('$lib/server/postgres', { namedExports: {
  query: (sql: string, args: unknown[]) => pool.query(sql, args),
  withTransaction: async (fn: any) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
}});
mock.module('$lib/server/groups', { namedExports: {
  getGroupBySlug: async () => group,
  resolveGroupAdmin: async (_g: unknown, u: typeof user | null) => u?.subject === admin.subject
}});
mock.module('$lib/server/avatars', { namedExports: {
  emailMd5: (s: string) => s, ensureAvatarRows: async () => new Map(),
  avatarIdFor: async () => photo ? 'photo' : null,
  deleteAvatar: async () => { if (failAvatar) throw new Error('avatar unavailable'); photo = false; }
}});
mock.module('$lib/server/gravatar', { namedExports: { gravatarHash: () => null } });
mock.module('$lib/server/session-store', { namedExports: {
  SESSION_COOKIE_NAME: 'sid', SESSION_COOKIE_OPTIONS: {},
  deleteUserSessions: async () => { sessions.clear(); },
  deleteSession: async (sid: string) => { sessions.delete(sid); }
}});
mock.module('$lib/server/log', { namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } } });
const { migrate } = await import(source('src/lib/server/migrations.ts'));
const edit = await import(source('src/routes/group/[slug]/members/[id]/edit/+page.server.ts'));
const removal = await import(source('src/routes/group/[slug]/removal/[id]/+page.server.ts'));
const groupLayout = await import(source('src/routes/group/[slug]/+layout.server.ts'));
const memberLayout = await import(source('src/routes/group/[slug]/members/+layout.server.ts'));
registerHooks({ resolve(s, c, next) {
  if (s === '$app/paths/internal/server') return { shortCircuit: true,
    url: 'data:text/javascript,export const base="",assets="",app_dir="_app",relative=false;' };
  return next(s, c);
}});
(globalThis as any).__SVELTEKIT_SERVER_TRACING_ENABLED__ = false;
const { render_page } = await import(source('node_modules/@sveltejs/kit/src/runtime/server/page/index.js'));
const { PageNodes } = await import(source('node_modules/@sveltejs/kit/src/utils/page_nodes.js'));
before(async () => {
  await migrate(pool);
  const r = await pool.query('INSERT INTO "group" (slug,name) VALUES ($1,$2) RETURNING id', [group.slug,group.name]);
  group.id = r.rows[0].id;
});
beforeEach(async () => {
  await pool.query('DELETE FROM member WHERE group_id=$1', [group.id]);
  const r = await pool.query('INSERT INTO member (group_id,email,name,ident_subject) VALUES ($1,$2,$3,$4) RETURNING id',
    [group.id,user.email,'Member',user.subject]);
  id = r.rows[0].id; failAvatar = false; photo = true; sessions.clear(); sessions.add('initial');
});
after(async () => { await pool.end(); });
function event(who: typeof user, path = `/members/${id}/edit?/delete`) {
  const url = new URL(`https://example.org${path}`);
  return {params: {slug: group.slug, id}, locals: {user: who}, url,
    request: new Request(url, {method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded', accept: 'text/html'}, body: ''}),
    route: {id: '/group/[slug]/members/[id]/edit'}, setHeaders() {}, fetch: globalThis.fetch,
    cookies: {get: () => 'initial', delete() {}}};
}
async function outcome(fn: () => unknown): Promise<any> { try { return await fn(); } catch(e) { return e; } }

test('E32 R6: an unenhanced delete exposes the cleanup failure and recovery route', async () => {
  failAvatar = true;
  const nodes = [groupLayout, memberLayout, edit].map((server,index) => ({server,index}));
  const response = await render_page(event(user), {tracing: {enabled: false}},
    {leaf: 2, layouts: [0,1], errors: []},
    {hooks: {transport: {}, handleError: ({error}: any) => {throw error;}},
     templates: {error: ({message}: any) => message}},
    {_: {nodes: nodes.map(n => async () => n)}}, {depth: 0}, new PageNodes(nodes), {});
  const body = await response.text();
  const location = response.headers.get('location');
  const members = (await pool.query('SELECT id FROM member WHERE id=$1',[id])).rowCount;
  console.log(JSON.stringify({status: response.status, location, members, photo, body}));
  assert.equal(members, 0); assert.equal(photo, true);
  assert.ok(location?.includes(`/removal/${id}`),
    'plain form POST hid the failure behind /request and offered no recovery');
  await removal.load(event(user, location!) as never);
  failAvatar = false;
  const retry = await outcome(() => removal.actions.default(event(user, location!) as never));
  assert.equal(retry.status, 303); assert.equal(photo, false); assert.equal(sessions.size, 0);
});

test('E32 R6: replaying a completed removal cannot revoke a later sign-in', async () => {
  const first = await outcome(() => edit.actions.delete(event(admin) as never));
  assert.equal(first.status, 303); assert.equal(sessions.size, 0);
  sessions.add('signed-in-after-removal');
  const repeated = await outcome(() => removal.actions.default(event(admin, `/removal/${id}`) as never));
  console.log(JSON.stringify({first: first.status, repeated: repeated.status, laterSessions: [...sessions]}));
  assert.ok(sessions.has('signed-in-after-removal'),
    'the completed removal still grants the former group admin authority over a later sign-in');
});
