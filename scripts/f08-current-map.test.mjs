import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

assert.ok(process.env.F8_IMPLEMENTATION_REPORT, 'Set F8_IMPLEMENTATION_REPORT to the current run report');
const report = readFileSync(process.env.F8_IMPLEMENTATION_REPORT, 'utf8');
const files = execFileSync('git', ['ls-files', '*test.ts', '*test.mts', '*test.mjs'], { encoding: 'utf8' })
  .trim().split('\n');
const titles = files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/test\(\s*(['"])(.*?)\1/g)]
  .map(match => match[2]));

for (const requirement of [2, 3, 4]) {
  test(`review: F8 R${requirement} has its own current report row naming a committed test`, () => {
    const row = report.split('\n').find(line =>
      new RegExp(`^\\s*(?:-\\s*R?${requirement}\\s*:|\\|\\s*R?${requirement}\\s*\\|)`).test(line)) ?? '';
    const matching = titles.filter(title => new RegExp(`F8 R${requirement}(?=[:/])`).test(title));
    assert.ok(row, `R${requirement} has no individual requirement-to-test row in the current report`);
    assert.ok(matching.some(title => row.includes(title)),
      `R${requirement} names no committed test title in its current report row`);
  });
}
