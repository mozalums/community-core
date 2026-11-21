import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const file = (p) => pathToFileURL(resolve(p)).href;
const { checkProfileUrl } = await import(file('src/lib/server/profile-url.ts'));
const { MemberWriteError, validatePatch } = await import(file('src/lib/server/member-write-core.ts'));

test('R1: avatar URL fields must pass the same URL check', () => {
  const schema = [{ key: 'photo', label: 'Photo', type: 'url', visibility: 'private', role: 'avatar', order: 0 }];
  assert.throws(
    () => validatePatch({ photo: 'javascript:alert(1)' }, { schema, writer: 'system', mayWritePrivate: true }),
    (e) => e instanceof MemberWriteError && e.status === 400 && e.field === 'photo' && /Photo/.test(e.message)
  );
});

test('R1: accepted URL resolves identically with and without a page base', () => {
  for (const raw of ['https:example.org/ada', 'https:/example.org/ada']) {
    const checked = checkProfileUrl(raw);
    if (!checked.ok) continue;
    assert.equal(new URL(checked.url, 'https://directory.example/group/a/members/1').href,
      new URL(checked.url).href, `accepted ${JSON.stringify(checked.url)} is relative to the page`);
  }
});
