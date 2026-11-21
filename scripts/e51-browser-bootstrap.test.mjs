import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

let sourceCache = dirname(chromium.executablePath());
while (!/^chromium-\d+$/.test(basename(sourceCache))) {
  assert.notEqual(sourceCache, dirname(sourceCache), 'cannot locate the installed browser cache');
  sourceCache = dirname(sourceCache);
}
sourceCache = dirname(sourceCache);
assert.ok(existsSync(chromium.executablePath()), 'the review fixture needs the existing pinned browser');

test('R4: StarButton tests prepare their own browser in a cold cache', () => {
  const dir = mkdtempSync(resolve('.svelte-kit/e51-browser-bootstrap-'));
  try {
    const cache = join(dir, 'browsers');
    const marker = join(dir, 'installer-called');
    const probe = join(dir, 'probe.mjs');
    mkdirSync(cache);
    // Substitute only the download: an installer call makes the already-installed
    // browser available in the isolated cache. All component/browser code is real.
    writeFileSync(probe, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const spawn = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (args?.includes('install') && args.includes('chromium')) {
    for (const entry of readdirSync(${JSON.stringify(sourceCache)}, {withFileTypes: true})) {
      if (entry.isDirectory()) symlinkSync(join(${JSON.stringify(sourceCache)}, entry.name), join(${JSON.stringify(cache)}, entry.name), 'dir');
    }
    writeFileSync(${JSON.stringify(marker)}, 'prepared');
    return {status: 0, signal: null, stdout: '', stderr: ''};
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`);
    const env = {...process.env, PLAYWRIGHT_BROWSERS_PATH: cache};
    delete env.NODE_TEST_CONTEXT;
    const run = args => spawnSync(process.execPath, ['--import', 'tsx', '--import', probe, ...args], {env, encoding: 'utf8'});
    const result = run(['src/lib/components/StarButton.test.ts']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(marker), 'the test relied on another process preparing Chromium');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
