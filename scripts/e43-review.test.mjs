import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.env.E43_REVIEW_ROOT || process.cwd();
const read = p => readFileSync(join(root, p), 'utf8');
const section = (page, name) => page.split(`## ${name}\n`)[1]?.split('\n## ')[0] || '';
const { findHits, trackedFiles, TERMS } = await import(pathToFileURL(join(root, 'scripts/check-neutral.ts')));

test('R2: first install provisions the selected community before checking the site', () => {
  const install = section(read('docs/deployment.md'), 'First install');
  assert.match(install, /INSERT\s+INTO\s+"group"/i,
    'First install runs migrations but never inserts the community row. Document production SQL for skin.site.default_group, not the sample-member dev seed.');
});

test('R2: backup.env example can be sourced by backup.sh', () => {
  const block = read('docs/operations.md').match(/```dotenv\n(BACKUP_RCLONE_REMOTE=[\s\S]*?)\n```/)[1];
  const result = spawnSync('bash', ['-eu', '-c', block + '\nprintf "%s" "$BACKUP_AGE_RECIPIENTS"'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /age1operator\.\.\.\s+age1escrow\.\.\./);
});

test('R2: invalid mail transport is documented as a startup failure', () => {
  const row = read('docs/configuration.md').split('\n').find(l => /^\| `MAIL_TRANSPORT`/.test(l));
  assert.match(row, /refus\w* to start|startup|boot/i,
    'hooks.server.ts calls assertMailConfig before ensureSchema; an invalid MAIL_TRANSPORT prevents startup.');
  assert.doesNotMatch(row, /first send|answer 500/i);
});

test('R2: CI documentation treats DEPLOY_USER as optional with deploy default', () => {
  const row = section(read('docs/deployment.md'), 'CI deploys').split('\n').find(l => /^\| `DEPLOY_USER`/.test(l));
  assert.match(row, /optional/i);
  assert.match(row, /`deploy`/);
});

test('R7: a tracked file cannot bypass neutral checking by containing a NUL', () => {
  const repo = mkdtempSync(join(tmpdir(), 'e43-review-neutral-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    writeFileSync(join(repo, 'contaminated.md'), `header\u0000\n${TERMS[2]}\n`);
    execFileSync('git', ['-C', repo, 'add', 'contaminated.md']);
    const hits = findHits(trackedFiles(repo));
    assert.deepEqual(hits.map(h => [h.path, h.line, h.term]), [['contaminated.md', 2, TERMS[2]]]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('R8: completion test 1 uses the checked-in neutral guard', {skip: !existsSync(join(root, 'docs-internal/CORE_SPLIT_2026_11_13.md'))}, () => {
  const first = section(read('docs-internal/CORE_SPLIT_2026_11_13.md'), 'Completion test').split('\n2.')[0];
  assert.match(first, /scripts\/check-neutral\.ts/);
  assert.doesNotMatch(first, /git grep/);
  assert.match(first, /gitleaks/);
  assert.match(first, /rev-list --count HEAD/);
});


test('R2: first-install Compose commands consume deploy/deploy.env', () => {
  const repo = mkdtempSync(join(tmpdir(), 'e43-review-compose-'));
  try {
    mkdirSync(join(repo, 'deploy'));
    mkdirSync(join(repo, 'bin'));
    writeFileSync(join(repo, 'docker-compose.yml'), read('docker-compose.yml'));
    writeFileSync(join(repo, 'deploy/deploy.env'), 'LOREM_SECRETS_DIR=/tmp/e43-custom-secrets\nCOMPOSE_PROJECT_NAME=e43-custom\nLOREM_HOST_PORT=5999\n');
    writeFileSync(join(repo, 'bin/sudo'), '#!/bin/sh\nexec env -i PATH="$PATH" HOME="$HOME" "$@"\n');
    chmodSync(join(repo, 'bin/sudo'), 0o755);
    const install = section(read('docs/deployment.md'), 'First install');
    const schema = install.split('**7. Schema and start.**')[1].match(/```bash\n([\s\S]*?)\n```/)[1];
    const probe = schema.replace('cd /srv/community/www', 'cd "$E43_SCRATCH"')
      .replace(/run --build --rm migrate/g, 'config --no-env-resolution --format json > resolved.json')
      .replace(/up -d --build/g, 'config --no-env-resolution --format json > resolved.json');
    const result = spawnSync('bash', ['-eu', '-c', probe], {cwd: repo, encoding: 'utf8', env: {
      PATH: `${join(repo, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME, E43_SCRATCH: repo
    }});
    assert.equal(result.status, 0, result.stderr);
    const model = JSON.parse(readFileSync(join(repo, 'resolved.json'), 'utf8'));
    assert.equal(model.name, 'e43-custom', 'The documented command silently uses the default stack.');
    assert.equal(model.services['lorem-host'].ports[0].published, '5999');
    assert.equal(model.services['lorem-host'].env_file[0].path, '/tmp/e43-custom-secrets/.env');
  } finally { rmSync(repo, {recursive: true, force: true}); }
});


test('R2: first install sets the bootstrap admin before the final container creation', () => {
  const install = section(read('docs/deployment.md'), 'First install');
  const admin = install.indexOf('ADMIN_SUBJECTS=email:you@example.org');
  const starts = [...install.matchAll(/docker compose[^\n]*\bup\b/g)];
  assert.ok(admin >= 0 && starts.length && admin < starts.at(-1).index,
    'ADMIN_SUBJECTS is edited only after compose up, so the running container still has the empty template value.');
});

test('R2: the deploy reference describes every long option in deploy.sh help', () => {
  const help = spawnSync('bash', [join(root, 'deploy/deploy.sh'), '--help'], {encoding: 'utf8'});
  assert.equal(help.status, 0, help.stderr);
  const names = [...new Set(help.stdout.match(/--[a-z][a-z-]*/g))];
  const page = read('docs/deployment.md');
  const missing = names.filter(name => !page.includes(name));
  assert.deepEqual(missing, [], 'The public CLI reference omits shipped options.');
});

test('R2: moving hosts freezes the old writer before the final backup', () => {
  const move = section(read('docs/deployment.md'), 'Moving hosts');
  const stop = move.indexOf('docker compose stop lorem-host');
  const dump = move.indexOf('deploy/backup.sh');
  assert.ok(stop >= 0 && dump >= 0 && stop < dump,
    'The only dump precedes the old app stopping, so accepted writes vanish during the move.');
  assert.match(move, /docker compose[^\n]*\bup\b/,
    'The new host has no app container; compose start in the linked restore drill cannot create one.');
});
