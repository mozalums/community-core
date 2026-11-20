import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.env.E43_REVIEW_ROOT || process.cwd();
const reportFile = process.env.E43_REQUIREMENT_REPORT;
assert.ok(reportFile, 'Set E43_REQUIREMENT_REPORT to JSON containing a report string.');
const { report } = JSON.parse(readFileSync(reportFile, 'utf8'));
assert.equal(typeof report, 'string');
const source = execFileSync('git', ['ls-files', '-z', 'src', 'scripts'], {
  cwd: root, encoding: 'utf8'
}).split('\0').filter(p => /\.test\.(?:ts|mjs|js)$/.test(p))
  .map(p => readFileSync(join(root, p), 'utf8')).join('\n');

for (let requirement = 1; requirement <= 8; requirement++) {
  test(`R${requirement}: the current report names held tests on its own map line`, () => {
    const lines = report.split('\n').filter(line =>
      new RegExp(`^\\s*(?:[-*]\\s*(?:\\*\\*)?R${requirement}(?=\\s*(?:\\([^)]*\\))?\\s*(?:\\*\\*)?:)|\\|\\s*(?:R)?${requirement}\\s*\\|)`).test(line));
    assert.ok(lines.length, `R${requirement}: missing individual requirement-to-test entry`);
    const names = lines.flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(m => m[1]));
    assert.ok(names.some(name => source.includes(`test('${name}'`) || source.includes(`test("${name}"`)),
      `R${requirement}: entry names no test held by the branch`);
  });
}
