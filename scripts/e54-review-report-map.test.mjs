import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

assert.ok(process.env.E54_REPORT_JSON, 'set E54_REPORT_JSON to drover report E54 --json output or a draft with a report string');
const { report } = JSON.parse(readFileSync(process.env.E54_REPORT_JSON, 'utf8'));
const sources = ['src', 'scripts'].flatMap((root) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.test\.(?:ts|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name)))
  .map((path) => readFileSync(path, 'utf8').replaceAll("\\'", "'").replaceAll('\\"', '"'));

for (const req of [1, 2, 3, 4]) {
  test(`E54 R${req}: the current report names a test held by the branch`, () => {
    const prefix = new RegExp(`^(?:[-*]\\s+)?(?:R)?${req}\\s*:|^\\|\\s*(?:R)?${req}\\s*\\|`);
    const lines = report.split('\n').filter((line) => prefix.test(line.trim().replaceAll('**', '')));
    assert.ok(lines.length, `R${req}: missing individual requirement-to-test map line`);
    const names = lines.flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
    for (const path of names.filter((name) => /^(?:src|scripts)\/.*\.test\.(?:ts|mjs)$/.test(name)))
      assert.ok(existsSync(path), `R${req}: mapped test file does not exist: ${path}`);
    assert.ok(names.some((name) => sources.some((source) => source.includes(`test('${name}'`) || source.includes(`test("${name}"`))),
      `R${req}: mapped line names no test held by the branch`);
  });
}

