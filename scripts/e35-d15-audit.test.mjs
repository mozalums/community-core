import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Reads the security audit, which lives in docs-internal and is absent from a
// clone, so this runs by hand rather than under `pnpm test`:
//   E35_AUDIT_FILE=<path> node --test scripts/e35-d15-audit.test.mjs
// A missing file fails rather than skips: a skipped check reads as a pass.

const path = process.env.E35_AUDIT_FILE ?? 'docs-internal/SECURITY_AUDIT_2026_08_18.md';
const audit = readFileSync(path, 'utf8');

const indexRow = audit.split('\n').find((line) => /^\|\s*D15\s*\|/.test(line)) ?? '';
const start = audit.search(/^### D15\b/m);
const rest = start === -1 ? '' : audit.slice(start);
const next = rest.slice(1).search(/\n##+ /);
const section = next === -1 ? rest : rest.slice(0, next + 1);
const flat = section.replace(/\s+/g, ' ');

test('D15 is marked closed in the audit index and its own heading', () => {
	assert.match(indexRow, /\(closed\)/, `D15's index row is not closed: ${indexRow}`);
	assert.match(section.split('\n')[0], /\(closed\)/, 'the D15 heading is not closed');
});

test('D15 records the posture decision, the mechanics, the count source and the residual', () => {
	assert.match(flat, /Closed by `E35`/);
	assert.match(flat, /"private" did not become true/);
	assert.match(flat, /"Members-only" is not a hedge on "private"/);
	assert.match(flat, /hyphen is now an em-dash/);
	assert.match(flat, /`countMembers`, the query the signed-in sidebar shows/);
	assert.match(flat, /\*\*Residual\.\*\*/);
});
