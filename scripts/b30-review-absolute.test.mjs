import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const file = (p) => pathToFileURL(resolve(p)).href;
const { checkProfileUrl, profileHref } = await import(file('src/lib/server/profile-url.ts'));
const { MemberWriteError, validatePatch } = await import(file('src/lib/server/member-write-core.ts'));
const schema = [{ key: 'website', label: 'Website', type: 'url', visibility: 'members', order: 0 }];
const bases = [
  'https://directory.example/group/a/members/1',
  'https://another.example/members/2'
];
const absolute = (value) => {
  for (const base of bases) {
    assert.equal(new URL(value, base).href, new URL(value).href,
      `${JSON.stringify(value)} changes destination on ${base}`);
  }
};

for (const raw of ['https:/page.invalid/../ada', 'https:page.invalid/../../../ada']) {
  test(`R1: the helper refuses or makes absolute ${raw}`, () => {
    const result = checkProfileUrl(raw);
    if (result.ok) absolute(result.url);
  });

  test(`R1: the write validator refuses or makes absolute ${raw}`, () => {
    let result;
    try {
      result = validatePatch({ website: raw }, { schema, writer: 'form', mayWritePrivate: true });
    } catch (e) {
      assert.ok(e instanceof MemberWriteError && e.status === 400 && e.field === 'website');
      assert.match(e.message, /Website/);
      return;
    }
    absolute(result.website);
  });

  test(`R1: the rendered href refuses or makes absolute ${raw}`, () => {
    const href = profileHref(raw);
    if (href !== null) absolute(href);
  });
}
