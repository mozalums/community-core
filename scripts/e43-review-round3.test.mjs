import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.env.E43_REVIEW_ROOT || process.cwd();
const read = path => readFileSync(join(root, path), 'utf8');
const { findHits, trackedFiles, TERMS } = await import(pathToFileURL(join(root, 'scripts/check-neutral.ts')));

test('R2: restoring a newer schema recreates the app from the selected checkout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e43-restore-image-'));
  try {
    mkdirSync(join(dir, 'deploy'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'deploy/deploy.env'), 'COMPOSE_PROJECT_NAME=review\n');
    writeFileSync(join(dir, 'app-image'), 'old\n');
    writeFileSync(join(dir, 'app-container'), 'old\n');
    writeFileSync(join(dir, 'database'), 'new\n');
    // Compose builds images separately from containers. start resumes the
    // existing container; up recreates it when its image has changed.
    writeFileSync(join(dir, 'bin/docker'), `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$E43_SCRATCH/calls"
case "$*" in
  *'--profile backup run'*) printf 'new\\n' > "$E43_SCRATCH/database" ;;
  *'--profile migrate run'*) printf 'new\\n' > "$E43_SCRATCH/migrator" ;;
  *'compose build'*) printf 'new\\n' > "$E43_SCRATCH/app-image" ;;
  *'compose up '*)
    case "$*" in *--build*) printf 'new\\n' > "$E43_SCRATCH/app-image";; esac
    cp "$E43_SCRATCH/app-image" "$E43_SCRATCH/app-container"
    cp "$E43_SCRATCH/app-container" "$E43_SCRATCH/served"
    ;;
  *'compose start '*) cp "$E43_SCRATCH/app-container" "$E43_SCRATCH/served" ;;
esac
`);
    chmodSync(join(dir, 'bin/docker'), 0o755);
    const block = read('docs/operations.md').split('**4. Only then, cut over.**')[1]
      .split('```bash\n')[1].split('\n```')[0];
    const commands = block.replace(/^sudo -s[^\n]*\n/m, '')
      .replace('cd /srv/community/www', 'cd "$E43_SCRATCH"');
    const result = spawnSync('bash', ['-c', commands], {
      cwd: dir, encoding: 'utf8', env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`, E43_SCRATCH: dir
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const served = readFileSync(join(dir, 'served'), 'utf8').trim();
    const schema = readFileSync(join(dir, 'database'), 'utf8').trim();
    assert.equal(served, schema,
      `Restore exited ${result.status}, serving ${served} against ${schema}:\n${readFileSync(join(dir, 'calls'), 'utf8')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R7: a clean sparse checkout cannot hide content Git exports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e43-neutral-sparse-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'visible.md'), 'neutral\n');
    writeFileSync(join(dir, 'hidden.md'), `${TERMS[2]}\n`);
    git('add', '.');
    git('-c', 'user.name=Review', '-c', 'user.email=review@example.org',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    git('sparse-checkout', 'set', '--no-cone', '/visible.md');
    assert.equal(git('status', '--porcelain'), '', 'The checkout must be clean.');
    assert.equal(existsSync(join(dir, 'hidden.md')), false);
    const archive = execFileSync('git', ['-C', dir, 'archive', 'HEAD']);
    assert.equal(execFileSync('tar', ['-xOf', '-', 'hidden.md'], {
      input: archive, encoding: 'utf8'
    }), `${TERMS[2]}\n`);
    assert.deepEqual(findHits(trackedFiles(dir)).map(h => [h.path, h.line, h.term]),
      [['hidden.md', 1, TERMS[2]]], 'Git ships this blob even though sparse checkout leaves it absent.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
