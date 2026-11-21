import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';

test('E35 R6: D15 cites tests that exist', () => {
  const audit = readFileSync(process.env.E35_AUDIT_FILE ?? 'docs-internal/SECURITY_AUDIT_2026_08_18.md', 'utf8');
  const section = audit.split(/^### D15\b/m)[1]?.split(/^### /m)[0] ?? '';
  assert.ok(section, 'D15 is missing');
  for (const [, file] of section.matchAll(/`((?:src|scripts)\/[^`]+\.test\.(?:ts|mjs))`/g)) {
    assert.ok(existsSync(file), `D15 cites missing test: ${file}`);
  }
});
