import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const report = readFileSync(process.env.E32_IMPLEMENTATION_REPORT ??
  'docs-internal/verdicts/E32-there-is-no-privacy-notice-footer-or-removal.md', 'utf8');
const start = report.indexOf('## Requirement → test');
assert.ok(start >= 0, 'the current report has no requirement-to-test map');
const map = report.slice(start, report.indexOf('**Verification:**', start));
const tests = readFileSync('src/lib/skin/skin.test.ts', 'utf8');

test('E32 R7: the report names the committed contact-disclosure test', () => {
  const entry = map.split('\n').find(line => /^- Notice 7:/.test(line));
  assert.match(entry ?? '', /E32 R7:/, 'Notice 7 names runbook evidence, not a test of the disclosure');
  assert.match(tests, /test\(\s*["']E32 R7:/);
});

test('E32 I3: the report maps the privacy route to a route test', () => {
  const entry = map.split('\n').find(line => /^- I3\b/.test(line));
  assert.match(entry ?? '', /E32 I(?:3|5):/, 'I3 maps only to a footer source test, which never exercises the route or page');
  assert.match(tests, /test\(\s*["']E32 I3:/);
});
