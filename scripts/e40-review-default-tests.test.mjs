import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? testFiles(path) : path.endsWith('.test.ts') ? [path] : [];
  });
}

test('R7: application tests load the default skin regardless of their directory', () => {
  assert.match(JSON.parse(readFileSync('package.json', 'utf8')).scripts.test, /^SKIN_DIR=skin\/default node /);
  const overrides = testFiles('src').filter((path) => {
    if (path === 'src/lib/skin/skin.test.ts') return false;
    return /process\.env\.SKIN_DIR\s*=\s*['"](?!skin\/default['"])/m.test(readFileSync(path, 'utf8'));
  });
  assert.deepEqual(overrides, [], 'moving an application test under src/lib/skin does not make its subject the loader');
});
