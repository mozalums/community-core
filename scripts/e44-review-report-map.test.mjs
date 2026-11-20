import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';

const root = process.env.E44_REVIEW_ROOT || process.cwd();
assert.ok(process.env.E44_REQUIREMENT_REPORT, 'Set E44_REQUIREMENT_REPORT to the current report text.');
const report = readFileSync(process.env.E44_REQUIREMENT_REPORT, 'utf8');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(p => /\.test\.(?:ts|mjs|js|sh)$/.test(p));
const source = files.map(p => readFileSync(join(root, p), 'utf8')).join('\n');
const held = name => files.some(p => p === name || basename(p) === name) ||
  source.includes(`test('${name}'`) || source.includes(`test("${name}"`) ||
  source.includes(`ok '${name}'`) || source.includes(`result "${name}"`) ||
  source.includes(`check "${name}"`);
for (let r = 1; r <= 7; r++) {
  test(`R${r}: the current report maps the requirement to a test held by this branch`, () => {
    const lines = report.split('\n').filter(line => {
      const label = line.match(/^\s*[-*]\s*(?:\*\*)?(?:R)?(\d+(?:\/\d+)*)(?:\s*\([^)]*\))?(?:\*\*)?\s*:/)?.[1];
      return label?.split('/').includes(String(r));
    });
    assert.ok(lines.length, `R${r}: no individual requirement-to-test entry; a reference to an earlier report is insufficient`);
    const names = lines.flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]));
    assert.ok(names.some(held), `R${r}: entry names no test held by the branch`);
  });
}
