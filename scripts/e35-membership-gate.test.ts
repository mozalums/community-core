import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const local = (path: string) => pathToFileURL(resolve(root, path)).href;
const GROUP = { id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44', slug: 'example' };
const ROW = {
  id: '11111111-1111-4111-8111-111111111111', group_id: GROUP.id,
  name: 'Hidden Member', city: 'Private City', email: 'hidden@example.org',
  status: 'active', data: {}, ident_subject: null, linkedin: null
};
mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => GROUP } });
mock.module('$lib/server/postgres', { namedExports: {
  query: async (sql: string) => ({ rows: /FROM member\b/.test(sql) ? [ROW] : [], rowCount: 1 }),
  withTransaction: async () => assert.fail('read-only probe')
} });
const directory = await import(local('src/routes/group/[slug]/members/+page.server.ts'));
const gate = await import(local('src/routes/group/[slug]/members/+layout.server.ts'));
Object.assign(globalThis, { __SVELTEKIT_SERVER_TRACING_ENABLED__: false });
const { render_data } = await import(local('node_modules/@sveltejs/kit/src/runtime/server/data/index.js'));

async function response(invalidated: boolean[], suffix = '') {
  const url = new URL('https://www.example.org/members' + suffix);
  const event = {
    url, request: new Request(url), params: { slug: GROUP.slug },
    route: { id: '/group/[slug]/members' },
    locals: { user: { email: 'outsider@example.org', subject: 'outsider' } },
    tracing: { enabled: false }
  };
  const nodes = [
    { server: { load: async () => ({}) } },
    { server: { load: async () => ({ member: null, isGroupAdmin: false }) } },
    { server: gate },
    { server: directory }
  ];
  const result = await render_data(event, {}, { page: { layouts: [0, 1, 2], leaf: 3 } },
    { hooks: { transport: {}, handleError: ({ error }: any) => { throw error; } } },
    { _: { nodes: nodes.map((node) => async () => node) } }, {}, invalidated, 'never');
  return { status: result.status, body: await result.text() };
}

test('control: full layout load denies a signed-in non-member', async () => {
  const { body } = await response([true, true, true, true]);
  assert.equal(JSON.parse(body).type, 'redirect', body);
  assert.equal(JSON.parse(body).location, '/request');
});
for (const suffix of ['', '?q=Hidden']) {
  test(`E35 R2: leaf-only directory data denies a signed-in non-member ${suffix || '(list)'}`, async () => {
    const result = await response([false, false, false, true], suffix);
    console.log(JSON.stringify(result));
    assert.equal(JSON.parse(result.body).type, 'redirect', result.body);
    assert.equal(JSON.parse(result.body).location, '/request');
    assert.doesNotMatch(result.body, /Hidden Member|Private City/);
  });
}
