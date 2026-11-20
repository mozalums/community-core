import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
	EXCEPTIONS,
	SKIN_PREFIX,
	TERMS,
	findHits,
	formatHit,
	trackedFiles
} from '../scripts/check-neutral';

// E43: the readme splits by reader. Core keeps a README and reference pages
// written for any community; the one deployment's runbook moves into its skin.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const tracked = () =>
	execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const section = (page: string, heading: string) =>
	page.split(new RegExp(`^## ${heading}$`, 'm'))[1]?.split(/^## /m)[0] ?? '';
const RUNBOOK = `${SKIN_PREFIX}RUNBOOK.md`;
// The site's own names, derived rather than written so this file passes the
// check it tests and the E41 sweep for the community's name.
const SITE = SKIN_PREFIX.split('/')[1];
const HOST = `web.${['cow', 'org'].join('.')}`;
const AUTHORS = [['Matt', 'Mankins'], ['Ravi', 'Pina']].map((n) => n.join(' '));
const SITE_ENV = `${SKIN_PREFIX}deploy/env.example`;
// The exported core tree carries no community skin; the checks on its files
// run only where one is present.
const noSkin = !existsSync(join(ROOT, SKIN_PREFIX)) && 'this tree carries no community skin';
const YAML = ['skin', 'yaml'].join('.');

test('E43 R1: README.md replaces readme.md and orients a stranger', () => {
	const files = tracked();
	assert.ok(files.includes('README.md'), 'README.md is not tracked');
	assert.ok(!files.includes('readme.md'), 'readme.md is still tracked');

	const readme = read('README.md');
	assert.ok(section(readme, 'What a community gets').includes('- **'), 'no list of what a community gets');
	const quick = section(readme, 'Quick start');
	for (const step of ['docker-compose.dev.yml', 'cp .env.example .env', 'pnpm migrate', 'pnpm seed', 'pnpm dev', 'auth.magic.dev-link']) {
		assert.ok(quick.includes(step), `quick start lacks ${step}`);
	}
	// Spelled in parts: skin.test.ts reads the variable's name in a test as
	// that test selecting a skin.
	assert.ok(!quick.includes(['SKIN', 'DIR='].join('_')), 'the quick start should run the default skin');

	const skins = section(readme, 'Skins').trim();
	assert.equal(skins.split(/\n\s*\n/).length, 1, 'the skin explanation is more than one paragraph');
	assert.ok(skins.includes('](docs/skin.md)'), 'no link to docs/skin.md');

	const docs = section(readme, 'Documentation');
	for (const page of ['features', 'skin', 'configuration', 'data-model', 'deployment', 'operations', 'upgrading']) {
		assert.ok(docs.includes(`](docs/${page}.md)`), `Documentation does not link docs/${page}.md`);
	}
});

test('E43 R1: the authors are named with the span of their work, and no license is claimed', () => {
	const readme = read('README.md');
	const authors = section(readme, 'Authors');
	for (const name of AUTHORS) assert.ok(authors.includes(name), name);
	assert.match(authors, /May 2026[\s\S]*August 2026/, 'no span for the first author');
	assert.match(authors, /since August 2026/, 'no span for the second author');

	const license = section(readme, 'License').trim();
	assert.equal(license.split(/(?<=\.)\s+(?=[A-Z])/).length, 1, 'the license section is more than one sentence');
	assert.match(license, /No license has been chosen/);
	assert.equal(JSON.parse(read('package.json')).private, true);
	assert.ok(!tracked().some((f) => /^LICEN[SC]E/i.test(f)), 'a LICENSE file was added');
});

test('E43 R2: one reference page per subject under docs, written for any deployment', () => {
	const pages = ['deployment', 'configuration', 'data-model', 'operations', 'upgrading'];
	for (const page of pages) {
		const text = read(`docs/${page}.md`);
		assert.match(text, /^# /, `docs/${page}.md has no title`);
	}
	for (const page of ['deployment', 'configuration', 'operations']) {
		assert.match(read(`docs/${page}.md`), /example\.org/, `docs/${page}.md has no example.org`);
	}

	const deployment = read('docs/deployment.md');
	for (const heading of ['First install', 'Host configuration \\(`deploy/deploy.env`\\)', '`deploy/deploy.sh`', 'CI deploys', 'Migrations', 'Moving hosts']) {
		assert.ok(section(deployment, heading), `docs/deployment.md has no ${heading} section`);
	}
	const hostConfig = section(deployment, 'Host configuration \\(`deploy/deploy.env`\\)');
	const variables = [...read('deploy/deploy.env.example').matchAll(/^#([A-Z_]+)=/gm)].map((m) => m[1]);
	assert.equal(variables.length, 7, 'deploy/deploy.env.example no longer has seven variables');
	for (const v of variables) {
		assert.ok(hostConfig.includes(`| \`${v}\``), `${v} has no table row`);
		assert.ok(hostConfig.includes(`- **\`${v}\`**`), `${v} has no description`);
	}

	const operations = read('docs/operations.md');
	for (const heading of ['Running scripts on a host', 'Backups', 'Container isolation', 'Reverse proxy', 'Security headers']) {
		assert.ok(section(operations, heading), `docs/operations.md has no ${heading} section`);
	}
	assert.match(section(operations, 'Backups'), /^### Restoring$/m);

	const model = read('docs/data-model.md');
	for (const table of ['group', 'member', 'group_admin', 'access_request', 'member_avatar', 'member_star', 'audit_event', 'schema_migrations']) {
		assert.ok(model.includes(`- **\`${table}\`**`), `docs/data-model.md does not list ${table}`);
	}
});

test('E43 R2: docs/upgrading.md names the public interface and what each release kind may do', () => {
	const page = read('docs/upgrading.md');
	const flat = page.replace(/\s+/g, ' ');
	const iface = section(page, 'Public interface');
	for (const part of [`\`${YAML}\` format`, 'environment variables', "`deploy/deploy.sh`'s command line", 'The database']) {
		assert.ok(iface.includes(part), `the interface omits ${part}`);
	}
	assert.match(iface, /Code outside the interface carries no promise/);
	for (const rule of [
		/minor or patch release/i,
		/Every new key and variable is optional and has a default/,
		/Migrations run forward and at boot with no manual step/,
		new RegExp(`A feature members can see arrives switched off in \`${YAML.replace('.', '\\.')}\``),
		/Rename or remove, with each break and its replacement listed in the release notes/
	]) {
		assert.match(flat, rule);
	}
});

test('E43 R4: the site runbook lives in the skin and records this deployment, pointing at core for procedure', { skip: noSkin }, () => {
	assert.ok(tracked().includes(RUNBOOK), `${RUNBOOK} is not tracked`);
	const runbook = read(RUNBOOK);
	// Host, paths, account, DNS, mailboxes, certificates and storage, as the old
	// readme recorded them.
	for (const value of [
		HOST,
		`/web/${SITE}.com/www`,
		`/data/secrets/${SITE}.com/www`,
		`\`${SITE}\``,
		'/etc/sudoers.d/lorem-host-deploy',
		`dkim._domainkey.${SITE}.com`,
		`_dmarc.${SITE}.com`,
		`hello@${SITE}.com`,
		'/etc/letsencrypt',
		`b2:${SITE}-backups/postgres`
	]) {
		assert.ok(runbook.includes(value), `the runbook does not record ${value}`);
	}
	for (const page of ['deployment', 'operations', 'configuration']) {
		assert.ok(runbook.includes(`](../../docs/${page}.md`), `the runbook does not point at docs/${page}.md`);
	}
	for (const vhost of ['lorem-host.conf', 'moz-lorem-host.conf', `dev-${SITE}.conf`]) {
		assert.ok(tracked().includes(`${SKIN_PREFIX}deploy/nginx/${vhost}`), `${vhost} did not move to the skin`);
		assert.ok(!existsSync(join(ROOT, 'deploy/nginx', vhost)), `${vhost} is still in core`);
	}
});

test('E43 R5: .env.example takes example.org values, and the site values live in the skin', { skip: noSkin }, () => {
	const core = read('.env.example');
	const value = (text: string, key: string) => text.match(new RegExp(`^#? ?${key}=(.*)$`, 'm'))?.[1];
	const expected: Record<string, string> = {
		ORIGIN: 'https://www.example.org',
		PUBLIC_BASE_DOMAIN: 'example.org',
		SMTP_HOST: 'mail.example.org',
		SMTP_USER: 'no-reply@example.org',
		MAIL_FROM: 'no-reply@example.org',
		MAIL_DOMAIN: 'mg.example.org'
	};
	for (const [key, want] of Object.entries(expected)) assert.equal(value(core, key), want, key);
	assert.doesNotMatch(core, /\bcyan\b/i, 'the comment naming another project is still there');

	const site = read(SITE_ENV);
	assert.equal(value(site, 'ORIGIN'), `https://www.${SITE}.com`);
	assert.equal(value(site, 'PUBLIC_BASE_DOMAIN'), `${SITE}.com`);
	const keys = (text: string) => [...text.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
	assert.deepEqual(keys(site), keys(core), 'the site template and core template set different keys');
});

// bootstrap.sh needs sudo and docker; stubs stand in for both so the template
// choice can be driven end to end on any machine with bash.
function bootstrap(args: string[]) {
	const dir = mkdtempSync(join(tmpdir(), 'e43-bootstrap-'));
	const bin = join(dir, 'bin');
	execFileSync('mkdir', [bin]);
	writeFileSync(
		join(bin, 'sudo'),
		[
			'#!/usr/bin/env bash',
			'[[ $1 == -v ]] && exit 0',
			'if [[ $1 == install ]]; then shift; a=(); while (($#)); do case $1 in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done; exec install "${a[@]}"; fi',
			'exec "$@"'
		].join('\n')
	);
	writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
	chmodSync(join(bin, 'sudo'), 0o755);
	chmodSync(join(bin, 'docker'), 0o755);
	const r = spawnSync('bash', [join(ROOT, 'deploy/bootstrap.sh'), ...args], {
		cwd: tmpdir(),
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			LOREM_SECRETS_DIR: join(dir, 'secrets'),
			LOREM_BACKUP_DIR: join(dir, 'backups'),
			NO_COLOR: '1'
		}
	});
	return { ...r, dir };
}

test('E43 R5: deploy/bootstrap.sh seeds .env from the template --env-example names', { skip: noSkin || (process.getuid?.() === 0 && 'bootstrap.sh refuses root') }, () => {
	const site = bootstrap(['--env-example', SITE_ENV, '--origin', `https://www.${SITE}.com`]);
	try {
		assert.equal(site.status, 0, site.stderr);
		const env = readFileSync(join(site.dir, 'secrets/.env'), 'utf8');
		assert.ok(env.includes(`\nSMTP_HOST=mail.${HOST.slice(4)}\n`), 'the site template was not the one copied');
		assert.ok(env.includes(`\nORIGIN=https://www.${SITE}.com\n`));
		// set_key edits with GNU `sed -i -E`; BSD sed reads -E as a backup suffix
		// and substitutes nothing, so this half holds on Linux, where hosts run.
		if (process.platform === 'linux') {
			assert.match(env, /^POSTGRES_PASSWORD=[0-9a-zA-Z]{20,}$/m, 'the generated password was not carried across');
		}
	} finally {
		rmSync(site.dir, { recursive: true, force: true });
	}

	const plain = bootstrap([]);
	try {
		assert.equal(plain.status, 0, plain.stderr);
		assert.match(readFileSync(join(plain.dir, 'secrets/.env'), 'utf8'), /^SMTP_HOST=mail\.example\.org$/m);
	} finally {
		rmSync(plain.dir, { recursive: true, force: true });
	}

	const missing = bootstrap(['--dry-run', '--env-example', 'no/such/env.example']);
	try {
		assert.equal(missing.status, 3, missing.stderr);
		assert.match(missing.stderr, /No env template at .*no\/such\/env\.example/);
	} finally {
		rmSync(missing.dir, { recursive: true, force: true });
	}
});

test('E43 R6: the deploy files and compose name no site, and the units point at core docs', () => {
	const files = [
		'docker-compose.yml',
		'deploy/deploy.sh',
		'deploy/backup.sh',
		'deploy/run.sh',
		'deploy/bootstrap.sh',
		'deploy/deploy.env.example',
		'deploy/systemd/example-backup.service',
		'deploy/systemd/example-backup.timer'
	];
	const hits = findHits(files.map((path) => ({ path, text: read(path) })));
	assert.deepEqual(hits.map(formatHit), []);
	for (const unit of ['deploy/systemd/example-backup.service', 'deploy/systemd/example-backup.timer']) {
		const doc = read(unit).match(/^Documentation=(.*)$/m)?.[1] ?? '';
		assert.match(doc, /\/docs\/operations\.md$/, `${unit} Documentation=`);
	}
	assert.doesNotMatch(read('deploy/deploy.sh'), /\bE06\b/, 'a header comment names an internal item');
	assert.doesNotMatch(read('deploy/backup.sh'), /docs-internal/, 'a comment points at a file no clone has');
});

test('E43 R7: check-neutral runs in pnpm check beside check-node-pin', () => {
	const check: string = JSON.parse(read('package.json')).scripts.check;
	assert.match(check, /tsx scripts\/check-node-pin\.ts && tsx scripts\/check-neutral\.ts && /);
});

test('E43 R7: the check names each file and line, ignores the skin, and honors only its one exception', () => {
	assert.equal(TERMS.length, 8);
	assert.equal(EXCEPTIONS.length, 1, 'the exception list grew');
	assert.equal(EXCEPTIONS[0].path, 'src/lib/server/redact.ts');
	assert.ok(EXCEPTIONS[0].reason.length > 20, 'the exception carries no reason');

	const credential = TERMS[7];
	const hits = findHits([
		{ path: 'docs/a.md', text: `fine\nHosted at WWW.${['MOZA', 'LUMS'].join('')}.com\n` },
		{ path: `${SKIN_PREFIX}RUNBOOK.md`, text: TERMS.join(' ') },
		{ path: 'src/lib/server/redact.ts', text: `'${credential}_KEY'` },
		{ path: 'src/lib/server/other.ts', text: `'${credential}_KEY'` },
		{ path: 'src/x.ts', text: `${['semi', 'colons'].join('')} and ${['ident', '.agency'].join('')}` }
	]);
	assert.deepEqual(
		hits.map((h) => [h.path, h.line, h.term]),
		[
			['docs/a.md', 2, TERMS[1]],
			['src/lib/server/other.ts', 1, credential],
			['src/x.ts', 1, TERMS[3]],
			['src/x.ts', 1, TERMS[4]]
		]
	);
	assert.match(formatHit(hits[0]), /^docs\/a\.md:2: /);
});

test('E43 R7: the check reads every staged blob whatever stands on disk, plus unstaged edits, binary and link text included', () => {
	const repo = mkdtempSync(join(tmpdir(), 'e43-neutral-'));
	try {
		const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
		git('init', '-q');
		writeFileSync(join(repo, 'kept.md'), `one\n${TERMS[2]}\n`);
		writeFileSync(join(repo, 'gone.md'), TERMS[0]);
		writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, ...Buffer.from(TERMS[0])]));
		symlinkSync(`../${TERMS[5]}/missing`, join(repo, 'link'));
		git('add', '.');
		writeFileSync(join(repo, 'swapped.md'), TERMS[6]);
		writeFileSync(join(repo, 'edited.md'), 'neutral\n');
		git('add', '.');
		writeFileSync(join(repo, 'untracked.md'), TERMS[0]);
		// Deleting a path on disk, or putting a directory where it was, leaves
		// its blob staged: the next commit and its export still ship it.
		rmSync(join(repo, 'gone.md'));
		rmSync(join(repo, 'swapped.md'));
		mkdirSync(join(repo, 'swapped.md'));
		writeFileSync(join(repo, 'edited.md'), `neutral\n${TERMS[1]}\n`);
		assert.deepEqual(
			findHits(trackedFiles(repo)).map((h) => [h.path, h.line, h.term]),
			[
				['blob.bin', 1, TERMS[0]],
				['edited.md', 2, TERMS[1]],
				['gone.md', 1, TERMS[0]],
				['kept.md', 2, TERMS[2]],
				['link', 1, TERMS[5]],
				['swapped.md', 1, TERMS[6]]
			]
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test('E43 R8: the check passes on this tree', () => {
	const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/check-neutral.ts')], {
		cwd: ROOT,
		encoding: 'utf8'
	});
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /^neutral: /m);
});
