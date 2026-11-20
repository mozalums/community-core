import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = process.cwd();
const community = readdirSync(join(root, 'skin')).find((s) => s !== 'default');
const runbook = readFileSync(join(root, 'skin', community, 'RUNBOOK.md'), 'utf8');
const rollback = runbook.split('### 7. Rollback')[1];
const blocks = [...rollback.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

/** @typedef {{dir:string, live:string, saved:string, stamp:string, sha:string, env:Record<string,string|undefined>, command:string}} Fixture */
function fixture(stack, swapped) {
  const dir = mkdtempSync(join(tmpdir(), 'e45-recovery-'));
  const host = join(dir, 'web');
  const secrets = join(dir, 'secrets');
  const live = join(host, stack);
  const saved = swapped ? `${live}.monolith` : live;
  const stamp = join(dir, 'built-sha');
  const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org'};
  delete env.LOREM_BUILD_SHA;
  delete env.LOREM_DEPLOY_ROOT;
  delete env.LOREM_DEPLOY_SNAPSHOT;
  const git = (...args) => {
    const r = spawnSync('git', ['-C', saved, ...args], {env, encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  mkdirSync(join(saved, 'deploy'), {recursive: true});
  mkdirSync(join(secrets, 'cutover'), {recursive: true});
  mkdirSync(join(secrets, stack), {recursive: true});
  writeFileSync(join(saved, '.gitignore'), 'deploy/deploy.env\n');
  cpSync(join(root, 'deploy/deploy.sh'), join(saved, 'deploy/deploy.sh'));
  cpSync(join(root, 'docker-compose.yml'), join(saved, 'docker-compose.yml'));
  writeFileSync(join(saved, 'deploy/deploy.env'), `LOREM_SECRETS_DIR=${secrets}/${stack}\n`);
  writeFileSync(join(secrets, stack, '.env'), 'ORIGIN=https://example.org\n', {mode: 0o600});
  writeFileSync(join(secrets, stack, 'postgres.env'), 'POSTGRES_USER=fixture\n', {mode: 0o600});
  git('init', '--quiet', '--initial-branch=main');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'recorded checkout');
  const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(secrets, 'cutover', `${stack}-head`), `${sha}\n`);
  git('checkout', '--quiet', '--detach', sha);
  if (swapped) mkdirSync(live);
  const block = blocks.find((b) => b.includes(`cutover/${stack}-head`));
  assert.ok(block, `no ${stack} rollback block`);
  const command = block
    .replaceAll(`/web/${community}.com`, host)
    .replaceAll(`/data/secrets/${community}.com`, secrets)
    .replace(/^sudo -s\n/gm, '');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', {mode: 0o755});
  // Matches the compose file's default; no database or daemon is contacted.
  assert.match(readFileSync(join(root, 'docker-compose.yml'), 'utf8'), /LOREM_BUILD_SHA: \$\{LOREM_BUILD_SHA:-unknown\}/);
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\ncase " $* " in\n  *" build "*|*" --build "*)\n    value=\$\{LOREM_BUILD_SHA:-unknown\}\n    for arg in "$@"; do case "$arg" in LOREM_BUILD_SHA=*) value=\$\{arg#*=\} ;; esac; done\n    printf '%s' "$value" > ${quote(stamp)}\n    ;;\nesac\nexit 0\n`.replaceAll('\\$', '$'), {mode: 0o755});
  env.PATH = `${bin}:${env.PATH}`;
  return {dir, live, saved, stamp, sha, env, command};
}

for (const stack of ['www', 'dev']) {
  test(`R5: ${stack} rollback recovers a migration failure before the directory swap`, () => {
    const f = fixture(stack, false);
    try {
      const r = spawnSync('bash', ['-c', f.command], {cwd: f.dir, env: f.env, encoding: 'utf8'});
      assert.ok(existsSync(f.live), `${stack} checkout disappeared before restore: ${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      const head = spawnSync('git', ['-C', f.live, 'rev-parse', 'HEAD'], {env: f.env, encoding: 'utf8'});
      assert.equal(head.stdout.trim(), f.sha);
    } finally { rmSync(f.dir, {recursive: true, force: true}); }
  });
}

test('R5: dev rollback leaves the restored CI deploy command able to pass its branch precondition', () => {
  const f = fixture('dev', true);
  try {
    const restored = spawnSync('bash', ['-c', f.command], {cwd: f.dir, env: f.env, encoding: 'utf8'});
    assert.equal(restored.status, 0, restored.stderr);
    const deployed = spawnSync('bash', [join(f.live, 'deploy/deploy.sh'), '--dry-run'],
      {cwd: f.live, env: f.env, encoding: 'utf8'});
    assert.doesNotMatch(deployed.stderr, /On branch 'HEAD', not main/, deployed.stderr);
    const branch = spawnSync('git', ['-C', f.live, 'symbolic-ref', '--short', 'HEAD'], {env: f.env, encoding: 'utf8'});
    assert.equal(branch.stdout.trim(), 'main', 'the forced --yes deploy requires main');
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});

for (const stack of ['www', 'dev']) {
  test(`R5: ${stack} rollback rebuild carries the recorded SHA required by its footer check`, () => {
    const f = fixture(stack, true);
    try {
      const r = spawnSync('bash', ['-c', f.command], {cwd: f.dir, env: f.env, encoding: 'utf8'});
      assert.equal(r.status, 0, r.stderr);
      assert.equal(readFileSync(f.stamp, 'utf8'), f.sha, 'rollback rebuild uses compose default unknown');
    } finally { rmSync(f.dir, {recursive: true, force: true}); }
  });
}
