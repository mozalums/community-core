import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** @typedef {{root: string, scratch: string, checkout: string, dependencies: string, community: string}} BuildFixture */
const root = process.cwd();

function fixture() {
  const community = readdirSync(join(root, 'skin')).find((name) => name !== 'default');
  assert.ok(community, 'run in the monolith, or after the skin CI test-layout step');
  const scratch = mkdtempSync(join(tmpdir(), 'e45-dependency-path-'));
  return {root, scratch, checkout: join(scratch, 'core'),
    dependencies: join(scratch, `${community}-dependencies`, 'node_modules'), community};
}

test('[build] R2: default-build neutrality ignores the name of an external dependency directory', () => {
  const f = fixture();
  try {
    mkdirSync(f.checkout);
    for (const name of ['package.json', 'svelte.config.js', 'vite.config.ts', 'tsconfig.json',
      'tailwind.config.js', 'postcss.config.js', 'src', 'static', 'skin']) {
      cpSync(join(f.root, name), join(f.checkout, name), {recursive: true});
    }
    cpSync(join(f.root, 'node_modules'), f.dependencies,
      {recursive: true, verbatimSymlinks: true});
    symlinkSync(f.dependencies, join(f.checkout, 'node_modules'));
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test',
      '--test-name-pattern=E42 R7: a default build names', 'src/lib/skin/skin.test.ts'],
      {cwd: f.checkout, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(f.scratch, {recursive: true, force: true});
  }
});
