import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('R4: StarButton component tests fail when its click handler is disconnected', () => {
  const dir = mkdtempSync(resolve('.svelte-kit/e51-click-coverage-'));
  try {
    const component = readFileSync('src/lib/components/StarButton.svelte', 'utf8');
    const tests = readFileSync('src/lib/components/StarButton.test.ts', 'utf8');
    const click = /onclick=\{[^\n]*\}/;
    assert.match(component, click);
    const run = source => {
      writeFileSync(join(dir, 'StarButton.svelte'), source);
      writeFileSync(join(dir, 'StarButton.test.ts'), tests);
      return spawnSync(process.execPath, ['--import', 'tsx', join(dir, 'StarButton.test.ts')], {encoding:'utf8'});
    };
    const original = run(component);
    assert.equal(original.status, 0, original.stdout + original.stderr);
    const disconnected = run(component.replace(click, 'onclick={() => {}}'));
    console.log(disconnected.stdout);
    assert.notEqual(disconnected.status, 0, 'all component tests passed with a disconnected button');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
