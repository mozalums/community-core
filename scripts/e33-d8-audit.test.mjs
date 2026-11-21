import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Reads the security audit, which lives in docs-internal and is absent from a
// clone, so this runs by hand rather than under `pnpm test`:
//   E33_AUDIT_FILE=<path> node --test scripts/e33-d8-audit.test.mjs
// A missing file fails rather than skips: a skipped check reads as a pass.

const path = process.env.E33_AUDIT_FILE ?? 'docs-internal/SECURITY_AUDIT_2026_08_18.md';
const audit = readFileSync(path, 'utf8');

const indexRow = audit.split('\n').find((line) => /^\|\s*D8\s*\|/.test(line)) ?? '';
const start = audit.search(/^### D8\b/m);
const rest = start === -1 ? '' : audit.slice(start);
const next = rest.search(/\n##+ /);
const section = next === -1 ? rest : rest.slice(0, next);
const flat = section.replace(/\s+/g, ' ');

test('D8 is marked closed in the audit index and its own heading', () => {
	assert.ok(indexRow, 'D8 has no row in the findings index');
	assert.match(indexRow, /\(closed\)/, `D8's index row is not closed: ${indexRow}`);
	assert.ok(section, 'D8 has no section');
	assert.match(section.split('\n')[0], /\(closed\)/, 'the D8 heading is not closed');
});

test('D8 records the split intents, the login exits and the open review cadence', () => {
	assert.match(flat, /Closed by `E33`/, 'no closing item named');
	assert.match(flat, /"Login" keeps the sign-in/, 'Login intent not described');
	assert.match(flat, /Register" links to `<base>\/join`/, 'Register intent not described');
	assert.match(flat, /three steps above its one input/, 'the explain-before-ask order is missing');
	assert.match(flat, /no set turnaround/, 'the approval wait is not stated');
	assert.match(flat, /`\/login` has exits/, 'the login exits are missing');
	assert.match(flat, /wordmark links home/, 'the way home is missing');
	assert.match(flat, /Open: nobody has agreed to a review cadence/, 'the cadence gap is not left open');
});
