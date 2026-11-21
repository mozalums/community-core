import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = p => pathToFileURL(resolve(p)).href;
const { EVERY_ROLE_FIELDS, fieldSchemaWith } = await import(file('src/lib/server/field-schema-fake.ts'));
mock.module(file('src/lib/server/field-schema.ts'), { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });
const { updateMemberIn, UPDATE_SQL, SELECT_FOR_UPDATE_SQL } = await import(file('src/lib/server/member-write-core.ts'));
const original = 'https://example.org/ada';

async function save(patch, data = { givenName: 'Ada', familyName: 'Byron' }) {
  const row = {
    email: 'ada@example.org', ident_subject: 'oidc:ada', data,
    private_data: {}, name: 'Ada Byron', city: null, linkedin: original
  };
  const statements = [];
  const client = { query: async (text, values = []) => {
    statements.push({ text, values });
    return { rows: text === SELECT_FOR_UPDATE_SQL ? [structuredClone(row)] : [], rowCount: 1 };
  }};
  const count = await updateMemberIn(client, {
    group: { id: '00000000-0000-4000-8000-000000000001', slug: 'example' },
    memberId: '00000000-0000-4000-8000-0000000000aa',
    actor: { actorSubject: 'oidc:ada', actorEmail: 'ada@example.org' },
    authority: { admin: false }, writer: 'form', allow: ['photo'], recordPrivateValues: false, patch
  });
  const write = statements.find(s => s.text === UPDATE_SQL);
  return {
    count, wrote: !!write,
    column: write ? write.values[6] : row.linkedin,
    data: write ? JSON.parse(write.values[2]) : row.data
  };
}

test('R1 BRANCH-REGRESSION: an avatar-only patch preserves an omitted URL stored only in its typed column', async () => {
  const result = await save({ photo: 'https://directory.example/avatar/1' });
  console.log(JSON.stringify({ case: 'avatar-only', ...result }));
  assert.equal(result.column, original);
  assert.equal(result.count, 1);
});

test('R1 BRANCH-REGRESSION: an empty patch remains a no-op with a typed-only URL', async () => {
  const result = await save({});
  console.log(JSON.stringify({ case: 'empty-patch', ...result }));
  assert.equal(result.wrote, false);
  assert.equal(result.column, original);
  assert.equal(result.count, 0);
});

test('R1 BRANCH-REGRESSION: an unrelated patch does not promote an unvalidated legacy URL', async () => {
  const data = { givenName: 'Ada', familyName: 'Byron', website: 'javascript:alert(1)' };
  const result = await save({ photo: 'https://directory.example/avatar/1' }, data);
  console.log(JSON.stringify({ case: 'unvalidated-json', ...result }));
  assert.equal(result.column, original);
  assert.equal(result.data.website, data.website);
  assert.equal(result.count, 1);
});

for (const other of [{}, { givenName: 'Augusta' }]) {
  test(`R1: an explicit empty URL clears a typed-only legacy value (other edit: ${!!other.givenName})`, async () => {
    const result = await save({ ...other, website: '' });
    console.log(JSON.stringify({ case: 'explicit-clear', otherEdit: !!other.givenName, ...result }));
    assert.equal(result.column, null);
    assert.ok(!Object.hasOwn(result.data, 'website'));
  });
}
