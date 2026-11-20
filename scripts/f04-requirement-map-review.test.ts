import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type RequirementEvidence = {
  requirement: number;
  line: string | null;
  testNames: string[];
};

const report = process.env.F04_REPORT_PATH
  ? readFileSync(process.env.F04_REPORT_PATH, 'utf8')
  : JSON.parse(execFileSync('drover', ['report', 'F4', '--json'], { encoding: 'utf8' })).report;
assert.equal(typeof report, 'string');
const map = report.split(/^## Requirement[^\n]*test[^\n]*$/m)[1]?.split(/^## /m)[0] ?? '';
const entries: RequirementEvidence[] = Array.from({ length: 12 }, (_, i) => {
  const requirement = i + 1;
  const line = map.match(new RegExp(`^\\s*(?:-\\s*)?R?${requirement}:\\s*(.+)$`, 'm'))?.[1] ?? null;
  return { requirement, line, testNames: [...(line ?? '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]) };
});

for (const entry of entries) {
  test(`F4 report has an explicit named-test entry for R${entry.requirement}`, () => {
    assert.ok(entry.line, `R${entry.requirement}: missing individual requirement-to-test entry`);
    assert.ok(entry.testNames.length > 0, `R${entry.requirement}: entry names no test`);
  });
}
