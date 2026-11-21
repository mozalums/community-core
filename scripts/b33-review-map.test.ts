import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

type Mapping = { requirement: number; entry: string; names: string[] };
const report = readFileSync(
  process.env.B33_REPORT ?? 'docs-internal/verdicts/B33-admin-data-loads-disclose-requests-and-grants-to.md',
  'utf8'
);
const map = report.split('**Requirement to test map**')[1]?.split('**Behavior changes')[0] ?? '';
const trackedTests = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0').filter((p) => /\.test\.[cm]?[jt]s$/.test(p));
const testNames = trackedTests.flatMap((p) =>
  [...readFileSync(p, 'utf8').matchAll(/\btest\(\s*(['"`])([^'"`\n]+)\1/g)].map((m) => m[2])
);
for (const requirement of [2, 5]) {
  const entry = map.split('\n').find((line) => line.startsWith(`- ${requirement}:`)) ?? '';
  const row: Mapping = {
    requirement, entry,
    names: [...entry.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  };
  test(`R${row.requirement}: report maps a named test held by the branch`, () => {
    assert.ok(
      row.names.some((name) => testNames.includes(name)),
      `R${row.requirement} names no branch-held test: ${row.entry}`
    );
  });
}
