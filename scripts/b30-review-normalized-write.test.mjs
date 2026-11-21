import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = p => pathToFileURL(resolve(p)).href;
const { EVERY_ROLE_FIELDS, fieldSchemaWith } = await import(file('src/lib/server/field-schema-fake.ts'));
mock.module(file('src/lib/server/field-schema.ts'), { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });
const { updateMemberIn, UPDATE_SQL, SELECT_FOR_UPDATE_SQL } = await import(file('src/lib/server/member-write-core.ts'));
const { checkProfileUrl, profileHref } = await import(file('src/lib/server/profile-url.ts'));

for (const alsoEditName of [false, true]) {
  test(`R1: saving a normalized URL repairs stored non-URL whitespace (other edit: ${alsoEditName})`, async () => {
    const expected = 'https://example.org/ada';
    const legacy = ' ' + expected;
    const checked = checkProfileUrl(legacy);
    assert.deepEqual(checked, { ok: true, url: expected });
    const statements = [];
    const row = {
      email: 'ada@example.org', ident_subject: 'oidc:ada',
      data: { givenName: 'Ada', familyName: 'Byron', website: legacy },
      private_data: {}, name: 'Ada Byron', city: null, linkedin: legacy
    };
    const client = { query: async (text, values = []) => {
      statements.push({ text, values });
      return { rows: text === SELECT_FOR_UPDATE_SQL ? [structuredClone(row)] : [], rowCount: 1 };
    }};
    await updateMemberIn(client, {
      group: { id: '00000000-0000-4000-8000-000000000001', slug: 'example' },
      memberId: '00000000-0000-4000-8000-0000000000aa',
      actor: { actorSubject: 'oidc:ada', actorEmail: 'ada@example.org' },
      authority: { admin: false }, writer: 'form', recordPrivateValues: false,
      patch: { website: expected, ...(alsoEditName ? { givenName: 'Augusta' } : {}) }
    });
    const write = statements.find(s => s.text === UPDATE_SQL);
    const stored = write ? JSON.parse(write.values[2]).website : row.data.website;
    const column = write ? write.values[6] : row.linkedin;
    console.log(JSON.stringify({ alsoEditName, wrote: !!write, stored, column, href: profileHref(stored) }));
    for (const [where, value] of [['data.website', stored], ['linkedin', column]]) {
      for (const base of [undefined, 'https://directory.example/group/a/members/1', 'https://example.org/a/b']) {
        let actual;
        try { actual = new URL(value, base).href; } catch { actual = 'INVALID_URL'; }
        assert.equal(actual, new URL(checked.url).href, `${where} resolves incorrectly with base ${base}`);
      }
    }
  });
}
