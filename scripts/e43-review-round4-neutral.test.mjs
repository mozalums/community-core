import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const root = process.env.E43_REVIEW_ROOT || process.cwd();
const { findHits, trackedFiles, TERMS } = await import(pathToFileURL(join(root, 'scripts/check-neutral.ts')));

test('R7: a replaced parent directory cannot make the guard read outside the repository', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'e43-parent-link-'));
  const repo = join(scratch, 'repo');
  const outside = join(scratch, 'outside');
  try {
    mkdirSync(repo);
    mkdirSync(outside);
    mkdirSync(join(repo, 'docs'));
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'docs/page.md'), `${TERMS[2]}\n`);
    execFileSync('git', ['-C', repo, 'add', '.']);
    writeFileSync(join(outside, 'page.md'), `${TERMS[0]} external-only-private-text\n`);
    rmSync(join(repo, 'docs'), { recursive: true });
    symlinkSync(outside, join(repo, 'docs'));
    const hits = findHits(trackedFiles(repo));
    assert.deepEqual(hits.map(h => [h.path, h.line, h.term, h.text]),
      [['docs/page.md', 1, TERMS[2], TERMS[2]]],
      'Only the staged blob belongs to this path; Git cannot stage a file through a symlink.');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
