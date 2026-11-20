import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, mock } from 'node:test';
const file = (p) => pathToFileURL(resolve(p)).href;

test('R6: profile edit controls retain their values under renamed skin role keys', async (t) => {
  const { currentSkin } = await import(file('src/lib/skin/load.ts'));
  const { fieldSchemaWith } = await import(file('src/lib/server/field-schema-fake.ts'));
  const fields = [
    ...currentSkin().skin.fields,
    { key: 'showOnHome', label: 'Public profile', type: 'checkbox', visibility: 'members', role: 'publicProfile' },
    { key: 'otherGroups', label: 'Other affiliations', type: 'text', visibility: 'members', role: 'affiliationOther' }
  ];
  const schema = fieldSchemaWith(fields);
  assert.equal(resolve(currentSkin().dir), resolve('skin/default'));
  assert.equal(schema.DEFAULT_FIELD_SCHEMA.length, 7);
  mock.module(file('src/lib/server/field-schema.ts'), { namedExports: schema });
  const unexpected = () => { throw new Error('unexpected database access'); };
  mock.module(file('src/lib/server/postgres.ts'), { namedExports: {
    query: unexpected, withTransaction: unexpected, pgPool: unexpected
  }});
  const { formUpdate, profilePatch } = await import(file('src/lib/server/member-edit.ts'));
  const { validatePatch } = await import(file('src/lib/server/member-write-core.ts'));
  const form = new FormData();
  form.set('name', 'Nomi Vance');
  form.set('publicProfile', 'on');
  form.set('otherAffiliations', 'Local group');
  const patch = profilePatch(formUpdate(form));
  t.diagnostic(JSON.stringify({ patch }));
  assert.doesNotThrow(() => validatePatch(patch, { writer: 'form', mayWritePrivate: true }));
  assert.deepEqual({ ...patch }, {
    name: 'Nomi Vance', showOnHome: true, otherGroups: 'Local group'
  });
});
