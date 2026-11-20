import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

type RequirementEvidence = { requirement: number; declared: string[]; held: string[] };
const reportPath = process.env.F2_REVIEW_REPORT;
assert.ok(reportPath, 'Set F2_REVIEW_REPORT to the current implementation report');
const report = readFileSync(reportPath, 'utf8');
const lines = report.split('\n');
const start = lines.findIndex((line) => /Requirement.*test map/i.test(line));
assert.ok(start >= 0, 'The report needs a Requirement → test map section');
const section = lines.slice(start + 1).join('\n').split(/\n(?:## |\*\*Behavior)/)[0];
const held = new Set<string>();
function readTests(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) readTests(path);
    else if (entry.name.endsWith('.test.ts')) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\btest\(\s*(['"])(.*?)\1\s*,/gs)) held.add(match[2]);
    }
  }
}
readTests('src');
readTests('scripts');
for (let requirement = 1; requirement <= 11; requirement += 1) {
  test(`R${requirement}: the current report names a test held by the branch`, () => {
    const line = section.split('\n').find((candidate) =>
      new RegExp(`^\\s*(?:-\\s*)?R?${requirement}\\s*:\\s+`).test(candidate));
    const declared = [...(line ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const evidence: RequirementEvidence = {
      requirement, declared, held: declared.filter((name) => held.has(name))
    };
    assert.ok(line, `R${requirement} has no individual requirement-to-test line`);
    assert.ok(evidence.held.length, `R${requirement} names no exact test held by the branch`);
  });
}
