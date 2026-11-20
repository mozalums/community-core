import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.env.E43_REVIEW_ROOT || process.cwd();
const read = p => readFileSync(join(root, p), 'utf8');
const section = (page, name) => page.split(`## ${name}\n`)[1]?.split('\n## ')[0] || '';
const { findHits, trackedFiles, TERMS } = await import(pathToFileURL(join(root, 'scripts/check-neutral.ts')));

test('R2: a failed restore cannot proceed to migrations or start the app', () => {
  const repo = mkdtempSync(join(tmpdir(), 'e43-review-restore-failure-'));
  try {
    mkdirSync(join(repo, 'deploy'));
    mkdirSync(join(repo, 'bin'));
    writeFileSync(join(repo, 'deploy/deploy.env'), 'COMPOSE_PROJECT_NAME=isolated-review\n');
    writeFileSync(join(repo, 'bin/docker'), `#!/bin/bash
printf '%s\\n' "$*" >> "$E43_CALL_LOG"
case "$*" in *'--profile backup run'*) exit 42;; esac
exit 0
`);
    chmodSync(join(repo, 'bin/docker'), 0o755);
    writeFileSync(join(repo, 'bin/sudo'), '#!/bin/bash\nexec "$@"\n');
    chmodSync(join(repo, 'bin/sudo'), 0o755);
    const restore = read('docs/operations.md').split('**4. Only then, cut over.**')[1].split('```bash\n')[1].split('\n```')[0];
    // Execute what the page puts in the root shell; never invoke real sudo.
    const commands = restore.replace(/^sudo -s[^\n]*\n/m, '')
      .replace('cd /srv/community/www', 'cd "$E43_SCRATCH"');
    const result = spawnSync('bash', ['-c', commands], {cwd: repo, encoding: 'utf8', env: {
      PATH: `${join(repo, 'bin')}:${process.env.PATH}`, E43_SCRATCH: repo, E43_CALL_LOG: join(repo, 'calls')
    }});
    const calls = readFileSync(join(repo, 'calls'), 'utf8');
    assert.doesNotMatch(calls, /--profile migrate|compose(?:[^\n]*)\b(?:start|up)\b/,
      `Restore failed with 42, but later commands ran (shell exit ${result.status}):\n${calls}`);
    assert.notEqual(result.status, 0, 'The failed restore must be reported as a failure.');
  } finally { rmSync(repo, {recursive: true, force: true}); }
});

test('R2: move rollback safety depends on accepted writes, not the DNS switch', () => {
  const move = section(read('docs/deployment.md'), 'Moving hosts');
  const rollback = move.split('**Rolling back**')[1] || '';
  assert.ok(rollback, 'Keep explicit rollback guidance for the move.');
  assert.doesNotMatch(rollback, /before DNS moves is[^\n]*\bstart lorem-host/,
    'Step 6 starts the new app and forwards old-address traffic to it before DNS moves. Restarting the old app at that point permits two writers.');
  assert.match(rollback, /stopp?\w* the new app/i);
  assert.match(rollback, /accepted writes|written|writes/i);
});

test('R7: tracked symlink blobs do not bypass the neutral check', () => {
  const repo = mkdtempSync(join(tmpdir(), 'e43-review-symlink-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    symlinkSync(`../${TERMS[2]}/asset.svg`, join(repo, 'asset.svg'));
    execFileSync('git', ['-C', repo, 'add', 'asset.svg']);
    assert.equal(execFileSync('git', ['-C', repo, 'show', ':asset.svg'], {encoding: 'utf8'}), `../${TERMS[2]}/asset.svg`);
    assert.deepEqual(findHits(trackedFiles(repo)).map(h => [h.path, h.line, h.term]),
      [['asset.svg', 1, TERMS[2]]], 'Scan the tracked link text, without following an external target.');
  } finally { rmSync(repo, {recursive: true, force: true}); }
});
