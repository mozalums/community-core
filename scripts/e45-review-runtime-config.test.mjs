import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = process.cwd();
const community = readdirSync(join(root, 'skin')).find((s) => s !== 'default');
const cutover = readFileSync(join(root, 'skin', community, 'RUNBOOK.md'), 'utf8')
  .split('## Cutover to the split repositories')[1];
const blocks = (text) => [...text.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const emailKey = ['GOOGLE', 'SA', 'EMAIL'].join('_');
const privateKey = ['GOOGLE', 'SA', 'PRIVATE', 'KEY'].join('_');

/** @typedef {{dir:string, host:string, secrets:string, env:Record<string,string|undefined>, run:(command:string)=>ReturnType<typeof spawnSync>}} RecoveryFixture */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'e45-runtime-config-'));
  const host = join(dir, 'web');
  const secrets = join(dir, 'secrets');
  const backups = join(dir, 'backups');
  const bin = join(dir, 'bin');
  for (const p of [host, secrets, backups, bin]) mkdirSync(p);
  const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.org',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.org'};
  const run = (command) => spawnSync('bash', ['-c', command
    .replaceAll(`/web/${community}.com`, host)
    .replaceAll(`/data/secrets/${community}.com`, secrets)
    .replaceAll('/var/backups/lorem-host', backups)
    .replace(/^sudo -s\n/gm, '')], {cwd: dir, env, encoding: 'utf8'});
  for (const stack of ['www', 'dev']) {
    const live = join(host, stack);
    mkdirSync(join(live, 'deploy'), {recursive: true});
    mkdirSync(join(secrets, stack));
    writeFileSync(join(live, '.gitignore'), 'deploy/deploy.env\n');
    cpSync(join(root, 'docker-compose.yml'), join(live, 'docker-compose.yml'));
    writeFileSync(join(live, 'deploy/deploy.env'), `LOREM_SECRETS_DIR=${secrets}/${stack}\nCOMPOSE_PROJECT_NAME=fixture-${stack}\n`);
    writeFileSync(join(secrets, stack, '.env'),
      `ORIGIN=https://${stack}.example.org\n${emailKey}=fixture@example.org\n${privateKey}=fixture-key\n`, {mode: 0o600});
    writeFileSync(join(secrets, stack, 'postgres.env'), 'POSTGRES_USER=fixture\nPOSTGRES_DB=fixture\n', {mode: 0o600});
    writeFileSync(join(backups, `cutover-${stack}.dump`), 'fixture dump\n');
    const init = run(`git -C ${quote(live)} init -q -b main && git -C ${quote(live)} add -A && git -C ${quote(live)} commit -qm recorded`);
    assert.equal(init.status, 0, init.stderr);
  }
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nif [ "$1" = "-u" ]; then shift 2; [ "$1" != "-H" ] || shift; fi\nexec "$@"\n', {mode: 0o755});
  // Migration-9 boot checks both credentials before serving any active group.
  // Docker is a stub; this checks its input file, never a daemon or real key.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh
case " $* " in
  *" up "*)
    grep -q '^${emailKey}=.' "$LOREM_SECRETS_DIR/.env" &&
    grep -q '^${privateKey}=.' "$LOREM_SECRETS_DIR/.env" || {
      echo 'legacy boot: no service account; the restored application exits' >&2
      exit 1
    }
    ;;
esac
exit 0
`, {mode: 0o755});
  env.PATH = `${bin}:${env.PATH}`;
  return {dir, host, secrets, env, run};
}

test('R5: production rollback retains or restores the runtime credentials its recorded checkout needs', () => {
  const f = fixture();
  try {
    const beforeKeys = cutover.split('### 4. Deploy keys and secrets')[0];
    for (const block of blocks(beforeKeys)) {
      if (!block.includes(`/web/${community}.com`)) continue;
      if (block.includes('deploy/run.sh sync')) continue;
      const r = f.run(block);
      assert.equal(r.status, 0, r.stderr);
    }
    const devBefore = readFileSync(join(f.secrets, 'dev/.env'), 'utf8');
    const production = cutover.split('### 6. Production')[1].split('### 7. Rollback')[0];
    // This models the prose instruction after production verification. Keeping
    // credentials for the rollback window also satisfies this test.
    const cleanup = production.split(/\n\n/).some((p) =>
      p.includes(`remove \`${emailKey}\``) && p.includes(`\`${privateKey}\``));
    if (cleanup) {
      const path = join(f.secrets, 'www/.env');
      writeFileSync(path, readFileSync(path, 'utf8').split('\n')
        .filter((line) => !line.startsWith(`${emailKey}=`) && !line.startsWith(`${privateKey}=`)).join('\n'));
    }
    renameSync(join(f.host, 'www'), join(f.host, 'www.monolith'));
    mkdirSync(join(f.host, 'www'));
    const rollback = blocks(cutover.split('### 7. Rollback')[1])
      .find((b) => b.includes('cutover/www-head'));
    assert.ok(rollback);
    const r = f.run(rollback);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(f.secrets, 'dev/.env'), 'utf8'), devBefore,
      'production recovery changed dev runtime configuration');
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
});
