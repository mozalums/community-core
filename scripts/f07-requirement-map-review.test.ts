import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type RequirementLine = { id: number; text: string; tests: string[] };
const path = process.env.F7_REPORT_FILE;
assert.ok(path, 'F7_REPORT_FILE must name the current implementation report');
const report = readFileSync(path, 'utf8');
const lines: RequirementLine[] = report.split('\n').flatMap(text => {
  const match = text.match(/^\s*(?:-\s*)?(?:R)?(\d+)(?:\s+\(R\d+\))?\s*:/);
  return match ? [{ id: Number(match[1]), text, tests: [...text.matchAll(/`([^`]+)`/g)].map(m => m[1]) }] : [];
});

test('R2/R3/R4/R5/R7/R8/R9/R10/R12/R13/R14/R15: the current report maps every requirement', () => {
  const absent = Array.from({ length: 16 }, (_, i) => i + 1).filter(id => !lines.some(line => line.id === id));
  assert.deepEqual(absent, [], 'missing requirement map entries: ' + absent.map(id => 'R' + id).join(', '));
});

test('R1: the mapped evidence exercises the merge default and no-removal behavior', () => {
  const mapped = lines.find(line => line.id === 1)?.tests ?? [];
  assert.ok(mapped.includes('R1: the mode defaults to merge, and only the literal replace selects replace'), 'R1 does not map its existing default-mode test');
  assert.ok(mapped.includes('R1: merge has no removal statement at all, whatever the file leaves out'), 'R1 does not map its existing no-removal test');
});
