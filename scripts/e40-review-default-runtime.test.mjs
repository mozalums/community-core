import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const loader = pathToFileURL(resolve('src/lib/skin/load.ts')).href;
const preload = 'data:text/javascript,' + encodeURIComponent(`
  import assert from 'node:assert/strict';
  import { resolve } from 'node:path';
  import { after } from 'node:test';
  after(async () => {
    const { currentSkin, skinDir } = await import(${JSON.stringify(loader)});
    const actual = { selected: resolve(skinDir()), loaded: resolve(currentSkin().dir) };
    const expected = { selected: resolve('skin/default'), loaded: resolve('skin/default') };
    console.log('R7 runtime ' + JSON.stringify(actual));
    assert.deepEqual(actual, expected, 'application regression probes must keep the default skin selected and loaded');
  });
`);

for (const name of ['renamed-fields', 'name-order', 'edit-controls']) {
  test(`R7: retained ${name} application probe keeps the default runtime skin`, () => {
    const env = { ...process.env, SKIN_DIR: 'skin/default' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--import', './src/lib/skin/register-node.ts', '--experimental-test-module-mocks', '--import', preload,
      '--test', `scripts/e40-review-${name}.test.mjs`
    ], { env, encoding: 'utf8', timeout: 30000 });
    assert.ifError(child.error);
    assert.match(child.stdout, /^ok 1 - R6:/m, 'the original application assertion did not pass');
    assert.match(child.stdout, /R7 runtime /, 'the runtime check did not run');
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}
