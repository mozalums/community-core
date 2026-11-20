import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, mock } from 'node:test';
const file = (p) => pathToFileURL(resolve(p)).href;
const { currentSkin } = await import(file('src/lib/skin/load.ts'));
const { fieldSchemaWith } = await import(file('src/lib/server/field-schema-fake.ts'));
assert.equal(currentSkin().skin.id, 'default');
const fields = [...currentSkin().skin.fields, {
  key: 'toString', label: 'Public profile', type: 'checkbox', visibility: 'members', role: 'publicProfile'
}];
mock.module(file('src/lib/server/field-schema.ts'), { namedExports: fieldSchemaWith(fields) });
const unexpected = () => { throw new Error('unexpected database access'); };
mock.module(file('src/lib/server/postgres.ts'), { namedExports: {
  query: unexpected, withTransaction: unexpected, pgPool: unexpected
}});
const { readAffiliations, formUpdate, profilePatch } = await import(file('src/lib/server/member-edit.ts'));
const { validatePatch, computeDelta } = await import(file('src/lib/server/member-write-core.ts'));

test('R6: an absent opt-in stays unchecked when its accepted key names an inherited property', () => {
  const data = { name: 'Nomi Vance' };
  const state = readAffiliations({ data });
  // These are the control names and checked state used by the real editor.
  const form = new FormData();
  form.set('name', data.name);
  if (state.publicProfile) form.set('publicProfile', 'on');
  const patch = profilePatch(formUpdate(form));
  validatePatch(patch, { writer: 'form', mayWritePrivate: true });
  const { next } = computeDelta(data, patch);
  form.set('publicProfile', 'on');
  const explicit = computeDelta(data, profilePatch(formUpdate(form)));
  const actual = { checked: state.publicProfile, patch: { ...patch }, storedOptIn: Object.hasOwn(next, 'toString') ? next.toString : null, explicitOptIn: Object.hasOwn(explicit.next, 'toString') ? explicit.next.toString : null };
  console.log(JSON.stringify(actual));
  assert.deepEqual(actual, { checked: false, patch: { name: 'Nomi Vance', toString: false }, storedOptIn: null, explicitOptIn: 'TRUE' });
});
