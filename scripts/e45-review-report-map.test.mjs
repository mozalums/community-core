import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';

/** @typedef {{report: string}} RequirementReport */
const root = process.env.E45_REVIEW_ROOT || process.cwd();
assert.ok(process.env.E45_REQUIREMENT_REPORT, 'Set E45_REQUIREMENT_REPORT to drover report E45 --json output, or a draft JSON object with a report string.');
/** @type {RequirementReport} */
const { report } = JSON.parse(readFileSync(process.env.E45_REQUIREMENT_REPORT, 'utf8'));
assert.equal(typeof report, 'string');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter((path) => /\.test\.(?:ts|mjs|js|sh)$/.test(path));
const sources = files.map((path) => readFileSync(join(root, path), 'utf8'));
const held = (name) => files.some((path) => path === name || basename(path) === name) ||
  sources.some((source) => source.includes(`'${name}'`) || source.includes(`"${name}"`));

for (let requirement = 1; requirement <= 5; requirement++) {
  test(`R${requirement}: the current report has its own line naming a test held by the branch`, () => {
    const prefix = new RegExp(`^(?:[-*]\\s+)?R?${requirement}\\s*:|^\\|\\s*R?${requirement}\\s*\\|`);
    const lines = report.split('\n').filter((line) => prefix.test(line.trim().replaceAll('**', '')));
    assert.ok(lines.length, `R${requirement}: missing individual requirement-to-test map line`);
    const names = lines.flatMap((line) => [...line.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]));
    assert.ok(names.some(held), `R${requirement}: mapped line names no test held by the branch`);
  });
}
