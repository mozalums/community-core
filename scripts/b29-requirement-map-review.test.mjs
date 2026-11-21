import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import ts from 'typescript';

const report = readFileSync(process.env.B29_REPORT_FILE ?? 'docs-internal/verdicts/B29-directory-year-search-excludes-members-with-an-o.md', 'utf8');
const map = report.split('**Requirement > test**')[1]?.split('\n\n')[0] ?? '';
const entry = map.split('\n').find(line => /^- \*\*4:\*\*/.test(line)) ?? '';
const held = [];
for (const file of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(file => /\.test\.[cm]?[jt]s$/.test(file))) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) held.push(title.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
test('R4: the completion map names a test held by this branch', () => {
  assert.ok(entry, 'R4 has no requirement-to-test entry');
  assert.ok(held.some(name => entry.includes('`' + name + '`')), 'R4 maps no test held by this branch');
});
