import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';

type RequirementEvidence = { requirement: number; block: string; testNames: string[] };
const reportPath = process.env.E12_REPORT_FILE;
assert.ok(reportPath, 'E12_REPORT_FILE must name the current completion report or its final draft');
const report = readFileSync(reportPath, 'utf8');
const map = report.split(/^## Requirement(?: map| > test| → test)\s*$/m)[1]?.split(/^## /m)[0] ?? '';
const blocks = map.split(/(?=^- R?\d+:)/m);
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const require = createRequire(join(process.cwd(), 'package.json'));
const ts = require('typescript');
const held: string[] = [];
for (const file of tracked.filter(file => /\.test\.[cm]?[jt]s$/.test(file))) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) held.push(title.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const evidence: RequirementEvidence[] = Array.from({ length: 10 }, (_, i) => {
  const requirement = i + 1;
  const block = blocks.find(value => new RegExp(`^- R?${requirement}:`).test(value)) ?? '';
  return { requirement, block, testNames: [...block.matchAll(/`([^`\n]+)`/g)].map(match => match[1]) };
});
for (const entry of evidence) {
  test(`E12 R${entry.requirement}: the completion map names a test held by this branch`, () => {
    assert.ok(entry.block, `R${entry.requirement}: missing individual requirement-to-test entry`);
    assert.ok(entry.testNames.some(name => held.includes(name)),
      `R${entry.requirement}: entry names no held test`);
  });
}
