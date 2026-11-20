import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, mock } from 'node:test';
const file = (p) => pathToFileURL(resolve(p)).href;
const require = createRequire(resolve('package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { currentSkin } = await import(file('src/lib/skin/load.ts'));
const { fieldSchemaWith } = await import(file('src/lib/server/field-schema-fake.ts'));
assert.equal(currentSkin().skin.id, 'default');
const fields = currentSkin().skin.fields.map((f) => f.role === 'name' ? { ...f, key: 'toString' } : f);
// The fixture helper validates these fields against the real skin schema.
mock.module(file('src/lib/server/field-schema.ts'), { namedExports: fieldSchemaWith(fields) });
const unexpected = () => { throw new Error('unexpected database access'); };
mock.module(file('src/lib/server/postgres.ts'), { namedExports: {
  query: unexpected, withTransaction: unexpected, pgPool: unexpected
}});
const { readEditFields, formUpdate, profilePatch } = await import(file('src/lib/server/member-edit.ts'));
const { validatePatch, computeDelta, deriveColumns } = await import(file('src/lib/server/member-write-core.ts'));
const store = (value) => ({ subscribe(fn) { fn(value); return () => {}; } });

test('R6: an accepted field key remains data through editor rendering, parsing and readback', async () => {
  const member = {
    name: 'Nomi Vance', city: null, linkedin: null,
    email: 'nomi@example.org', ident_subject: 'email:nomi@example.org',
    data: { toString: 'Nomi Vance' }, privateData: {}
  };
  const server = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
  try {
    const { default: Page } = await server.ssrLoadModule('/src/routes/group/[slug]/members/[id]/edit/+page.svelte');
    const { render } = await server.ssrLoadModule('svelte/server');
    const data = {
      group: { slug: 'example', name: 'Example Community' }, editName: member.name,
      fields: readEditFields(member),
      affiliations: { options: [], checks: {}, other: '', publicProfile: false, asked: false, hasOther: false, hasPublicProfile: false }
    };
    let body;
    assert.doesNotThrow(() => {
      ({ body } = render(Page, { props: { data, form: null }, context: new Map([['__svelte__', {
        page: store({ url: new URL('http://localhost/group/example/members/id/edit'), params: { id: 'id' } }),
        navigating: store(null), updated: store(false)
      }]]) }));
    });
    assert.match(body, /name="toString"/);
    assert.match(body, /value="Nomi Vance"/);
    const form = new FormData();
    form.set('toString', 'Nomi Vale');
    const patch = profilePatch(formUpdate(form));
    assert.doesNotThrow(() => validatePatch(patch, { writer: 'form', mayWritePrivate: true }));
    assert.deepEqual({ ...patch }, { toString: 'Nomi Vale' });
    const { next, changed } = computeDelta(member.data, patch);
    const saved = { ...member, ...deriveColumns(next, changed, member), data: next };
    assert.equal(saved.name, 'Nomi Vale');
    assert.equal(saved.email, member.email);
    assert.equal(readEditFields(saved).find((f) => f.name === 'toString').value, 'Nomi Vale');
  } finally { await server.close(); }
});
