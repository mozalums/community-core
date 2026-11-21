import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { test } from 'node:test';

assert.ok(process.env.B30_REQUIREMENT_REPORT, 'Set B30_REQUIREMENT_REPORT to the current or proposed final report.');
const report = readFileSync(process.env.B30_REQUIREMENT_REPORT, 'utf8');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter(p => /\.test\.(?:ts|mjs|js)$/.test(p));
const source = files.map(p => readFileSync(resolve(p), 'utf8')).join('\n');
const held = name => files.some(p => p === name || basename(p) === name) ||
  source.includes(`test('${name}'`) || source.includes(`test("${name}"`);

for (let r = 1; r <= 5; r++) {
  test(`R${r}: the report names a branch-held test for this requirement`, () => {
    const line = report.split('\n').find(line =>
      new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?R?${r}(?:\\*\\*)?\\s*:`).test(line));
    assert.ok(line, `R${r}: missing individual requirement-to-test entry; "unchanged" is not a test mapping`);
    const names = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    assert.ok(names.some(held), `R${r}: entry names no test held by the branch`);
  });
}
