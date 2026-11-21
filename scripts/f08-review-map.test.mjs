import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const report = readFileSync(process.env.F8_IMPLEMENTATION_REPORT ??
  'docs-internal/verdicts/F08-members-cannot-sign-in-with-a-passkey.md', 'utf8');
const row = report.split('\n').find(line => /^\|\s*6\s*\|/.test(line)) ?? '';
const citations = [...row.matchAll(/`([^`]+)`/g)].map(match => match[1]);
const sources = execFileSync('git', ['ls-files', '*test.ts', '*test.mts', '*test.mjs'], { encoding: 'utf8' })
  .trim().split('\n').map(path => readFileSync(path, 'utf8'));
const mapped = sources.filter(source => citations.some(title =>
  source.includes(`test('${title}'`) || source.includes(`test("${title}"`) ||
  source.includes(`test(\n\t'${title}'`) || source.includes(`test(\n\t"${title}"`)));

test('review: F8 R6 maps the required reference pages to committed tests', () => {
  for (const page of ['docs/features.md', 'docs/configuration.md']) {
    assert.ok(mapped.some(source => source.includes(page)),
      `R6 names no committed test that checks ${page}`);
  }
});
