import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

type RequirementEvidence = {
  requirement: number;
  block: string;
  testNames: string[];
};

const report = process.env.F3_REPORT_PATH
  ? readFileSync(process.env.F3_REPORT_PATH, 'utf8')
  : JSON.parse(execFileSync('drover', ['report', 'F3', '--json'], { encoding: 'utf8' })).report;
assert.equal(typeof report, 'string');
const map = report.split(/^## Requirement[^\n]*test[^\n]*$/m)[1]?.split(/^## /m)[0] ?? '';
const blocks = map.split(/(?=^- (?:R?\d))/m);
const evidence: RequirementEvidence[] = Array.from({ length: 13 }, (_, i) => i + 1)
  .filter(n => n !== 9)
  .map(requirement => {
    const block = blocks.find(b => new RegExp(`^- R?${requirement}:`).test(b)) ?? '';
    return { requirement, block, testNames: [...block.matchAll(/`([^`\n]+)`/g)].map(m => m[1]) };
  });
function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.name.endsWith('.test.ts') && !entry.name.startsWith('.')
      ? [readFileSync(path, 'utf8')] : [];
  });
}
const held = [...testSources('src'), ...testSources('scripts')]
  .flatMap(source => [...source.matchAll(/\btest\(\s*(['"`])([\s\S]*?)\1/g)].map(m => m[2]));
for (const entry of evidence) {
  test(`F3 report names held tests individually for R${entry.requirement}`, () => {
    assert.ok(entry.block, `R${entry.requirement}: missing individual requirement-to-test entry`);
    assert.ok(entry.testNames.some(name => held.includes(name)),
      `R${entry.requirement}: entry names no held test`);
  });
}
