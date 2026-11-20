import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, mock } from 'node:test';
const file = (p) => pathToFileURL(resolve(p)).href;

test('R6: request submission maps each name control by role when family name is listed first', async () => {
  const { currentSkin } = await import(file('src/lib/skin/load.ts'));
  const { fieldSchemaWith } = await import(file('src/lib/server/field-schema-fake.ts'));
  const fields = [
    { key: 'surname', label: 'Family name', type: 'text', visibility: 'members', role: 'familyName', column: 'name' },
    { key: 'forename', label: 'Given name', type: 'text', visibility: 'members', role: 'givenName', column: 'name' },
    { key: 'email', label: 'Email', type: 'email', visibility: 'private', role: 'email', column: 'email' },
    { key: 'workProfile', label: 'Work profile', type: 'url', visibility: 'members', column: 'linkedin' }
  ];
  const schema = fieldSchemaWith(fields);
  assert.equal(resolve(currentSkin().dir), resolve('skin/default'));
  assert.equal(schema.fieldByRole('givenName').key, 'forename');
  mock.module(file('src/lib/server/field-schema.ts'), { namedExports: schema });
  const { fakeRequestDb } = await import(file('src/lib/server/requests-fake.ts'));
  const db = fakeRequestDb();
  const group = { id: '00000000-0000-4000-8000-000000000001', slug: 'example', name: 'Example Community' };
  mock.module(file('src/lib/server/groups.ts'), { namedExports: { getGroupBySlug: async () => group } });
  mock.module(file('src/lib/server/email.ts'), { namedExports: { sendMembershipRequestNotice: async () => true } });
  mock.module(file('src/lib/server/rate-limit.ts'), { namedExports: {
    rateLimitKey: (bucket, id) => `${bucket}:${id}`, hashId: (s) => s, rateLimited: async () => false
  }});
  mock.module(file('src/lib/server/postgres.ts'), { namedExports: {
    query: db.query, withTransaction: db.withTransaction,
    pgPool: () => { throw new Error('unexpected database access'); }
  }});
  const { actions } = await import(file('src/routes/group/[slug]/request/+page.server.ts'));
  const { approveRequest } = await import(file('src/lib/server/requests.ts'));
  const url = new URL('https://www.example.org/group/example/request');
  const form = new FormData();
  form.set('firstName', 'Nomi');
  form.set('lastName', 'Vance');
  form.set('linkedin', 'https://example.org/nomi');
  const response = await actions.default({
    request: new Request(url, { method: 'POST', body: form }), url,
    params: { slug: 'example' }, locals: { user: { email: 'nomi@example.org', subject: 'email:nomi@example.org' } }
  });
  assert.equal(response.submitted, true);
  await approveRequest(group, db.requests[0].id, { actorSubject: 'email:admin@example.org' });
  assert.deepEqual({ name: db.members[0].name, data: db.members[0].data }, {
    name: 'Vance Nomi', data: { forename: 'Nomi', surname: 'Vance', workProfile: 'https://example.org/nomi' }
  });
});
