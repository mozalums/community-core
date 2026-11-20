import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

type RequirementEvidence = { line: string | undefined; declared: string[]; held: string[] };
const reportPath = process.env.E39_REVIEW_REPORT;
assert.ok(reportPath, 'Set E39_REVIEW_REPORT to the current implementation report');
const report = readFileSync(reportPath, 'utf8');
const section = report.split(/^## Requirement.*test.*$/m)[1]?.split(/^## /m)[0];
assert.ok(section, 'The report needs a requirement-to-test map');
const held = new Set<string>();
function collect(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name.endsWith('.test.ts')) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/\btest\(\s*(['"])(.*?)\1\s*,/gs)) held.add(match[2]);
    }
  }
}
collect('src');
test('R8: the report names a documentation test held by the branch', () => {
  const line = section.split('\n').find((candidate) => /^\s*(?:-\s*)?R?8\s*:/.test(candidate));
  const declared = [...(line ?? '').matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  const evidence: RequirementEvidence = { line, declared, held: declared.filter((name) => held.has(name)) };
  assert.ok(evidence.held.length, 'R8 names no exact test held by the branch');
});

