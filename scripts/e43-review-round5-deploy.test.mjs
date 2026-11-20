import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = process.env.E43_REVIEW_ROOT || process.cwd();
const source = readFileSync(join(root, 'deploy/deploy.sh'), 'utf8');
const page = readFileSync(join(root, 'docs/deployment.md'), 'utf8');
const move = page.split('## Moving hosts\n')[1];

// Use the branch's snapshot re-exec and start_stack verbatim. Docker is a
// file-backed stub; the child is supervised and reaped before the test exits.
test('R2: the documented host drain detects a deploy after its snapshot re-exec', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'e43-freeze-'));
  let child;
  let completion;
  try {
    mkdirSync(join(scratch, 'deploy'));
    mkdirSync(join(scratch, 'bin'));
    const prefix = source.slice(0, source.indexOf('\n# Where this host'));
    assert.ok(prefix.includes('exec bash "$snapshot" "$@"'), 'Keep this probe aligned with the snapshot implementation.');
    const start = source.match(/^start_stack\(\) \{[\s\S]*?^\}/m)?.[0];
    assert.ok(start);
    writeFileSync(join(scratch, 'deploy/deploy.sh'), prefix + `
DOCKER=("$E43_SCRATCH/bin/docker")
COMPOSE=()
TARGET=audit
E_START=6
step() { :; }
die() { exit "$1"; }
${start}
start_stack
`);
    writeFileSync(join(scratch, 'bin/docker'), `#!/bin/bash
set -eu
case "$*" in
  *'compose build'*)
    touch "$E43_SCRATCH/building"
    while [[ ! -f "$E43_SCRATCH/release" ]]; do sleep 0.02; done
    ;;
  *'compose up -d'*) printf running > "$E43_SCRATCH/writer" ;;
esac
`);
    chmodSync(join(scratch, 'bin/docker'), 0o755);
    writeFileSync(join(scratch, 'writer'), 'running');
    child = spawn('bash', [join(scratch, 'deploy/deploy.sh'), '--yes'], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, TMPDIR: scratch, E43_SCRATCH: scratch, LOREM_DEPLOY_SNAPSHOT: '' }
    });
    completion = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 250 && !existsSync(join(scratch, 'building')); i++) await delay(20);
    assert.ok(existsSync(join(scratch, 'building')), 'The exact start_stack must reach the blocked build.');
    const command = execFileSync('ps', ['-p', String(child.pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    const patterns = [...move.matchAll(/`pgrep -af ([^`]+)`/g)].map(m => m[1].replace(/^(['"])(.*)\1$/, '$2'));
    assert.ok(patterns.length, 'Document a host-process drain check, including the snapshot process.');
    const checks = [...new Set(patterns)].map(pattern => {
      const found = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
      const matched = (found.stdout || '').trim().split(/\s+/).includes(String(child.pid));
      return { pattern, matched };
    });
    const missed = checks.filter(check => !check.matched);
    // A recognized deploy is drained before stop. An unrecognized one is
    // still building when the documented check declares the host drained.
    if (missed.length) writeFileSync(join(scratch, 'writer'), 'stopped');
    writeFileSync(join(scratch, 'release'), 'go');
    const result = await completion;
    assert.equal(result.code, 0);
    if (!missed.length) writeFileSync(join(scratch, 'writer'), 'stopped');
    assert.equal(readFileSync(join(scratch, 'writer'), 'utf8'), 'stopped',
      `pgrep -af ${missed.map(check => check.pattern).join(', ')} missed PID ${child.pid}: ${command}; its subsequent compose up -d restarted the frozen writer.`);

  } finally {
    if (child) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      await completion;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
