import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const { loadSkinDir } = await import(pathToFileURL(resolve('src/lib/skin/load.ts')).href);

test('R6: the neutral skin contains the five fields in the contract', () => {
  const { fields } = loadSkinDir('skin/default').skin;
  assert.equal(fields.length, 5, `expected name, city, country, bio, phone; found ${fields.map((f) => f.key).join(', ')}`);
  assert.equal(fields.filter((f) => f.visibility === 'private').length, 1);
});

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? testFiles(path) : path.endsWith('.test.ts') ? [path] : [];
  });
}

test("R7: application tests do not replace the default skin with a community's fields", () => {
  assert.match(JSON.parse(readFileSync('package.json', 'utf8')).scripts.test, /^SKIN_DIR=skin\/default node /);
  const overrides = testFiles('src').filter((path) => /^import ['"]\$lib\/skin\/[a-z0-9-]+-fields['"];?/m.test(readFileSync(path, 'utf8')));
  assert.deepEqual(overrides, [], 'application tests must load the default skin; explicit skin-loader coverage may inspect both skins');
});
