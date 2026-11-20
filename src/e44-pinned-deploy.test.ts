import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SKIN_PREFIX } from '../scripts/check-neutral';

// E44: the deploy stops assuming one repository holds the platform and the
// site. Site files leave core, and the docs say how a host runs a site that
// pins core as a submodule.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const tracked = () =>
	execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const section = (page: string, heading: string) =>
	page.split(new RegExp(`^## ${heading}$`, 'm'))[1]?.split(/^## /m)[0] ?? '';
const noSkin = !existsSync(join(ROOT, SKIN_PREFIX)) && 'this tree carries no community skin';

const SITE_FILES = [
	'deploy/nginx/lorem-host.conf',
	'deploy/nginx/moz-lorem-host.conf',
	`deploy/nginx/dev-${SKIN_PREFIX.split('/')[1]}.conf`,
	'deploy/systemd/lorem-host-backup.service',
	'deploy/systemd/lorem-host-backup.timer'
];

test('E44 R1: the five site files live in the skin, not in core', { skip: noSkin }, () => {
	const files = tracked();
	for (const path of SITE_FILES) {
		assert.ok(files.includes(`${SKIN_PREFIX}${path}`), `${path} is not in the skin`);
		assert.ok(!files.includes(path), `${path} is still in core`);
	}
});

test('E44 R1: core keeps one example vhost and one example unit pair, and the docs say to copy and edit them', () => {
	const files = tracked();
	const coreDeploy = files.filter((p) => /^deploy\/(nginx|systemd)\//.test(p)).sort();
	assert.deepEqual(coreDeploy, [
		'deploy/nginx/example.conf',
		'deploy/systemd/example-backup.service',
		'deploy/systemd/example-backup.timer'
	]);
	assert.match(read('deploy/nginx/example.conf'), /server_name www\.example\.org;/);
	const service = read('deploy/systemd/example-backup.service');
	assert.match(service, /^WorkingDirectory=\/srv\/community\/www$/m);
	assert.match(service, /^ExecStart=\/srv\/community\/www\/deploy\/backup\.sh --quiet$/m);
	// The timer starts the service sharing its name, so the install copies both
	// under one name.
	assert.match(service, /example-backup\.service \/etc\/systemd\/system\/community-backup\.service/);
	assert.match(service, /example-backup\.timer \/etc\/systemd\/system\/community-backup\.timer/);

	const install = section(read('docs/deployment.md'), 'First install');
	assert.match(install, /`deploy\/nginx\/example\.conf` is the server-block template[^\n]*Copy it, replace `example\.org`/);
	assert.match(install, /`deploy\/systemd\/example-backup\.service` and `example-backup\.timer`: copy both and edit the path/);
	assert.match(read('docs/operations.md'), /sudo cp deploy\/systemd\/example-backup\.service \/etc\/systemd\/system\/community-backup\.service/);
});

test('E44 R7: deployment.md documents the pinned layout: the clone, what deploy.sh does differently, and moving the pin', () => {
	const pinned = section(read('docs/deployment.md'), 'Pinned layout');
	assert.ok(pinned, 'no Pinned layout section');
	for (const fact of [
		'git clone --recurse-submodules',
		'git submodule update --init',
		'core/deploy/deploy.sh',
		'layout: pinned',
		'`v{major}.{minor}.{patch}` tag',
		'naming the commit and the nearest tag',
		"core's checked-out commit is the one the site's commit records",
		"core's `src/lib/server/migrations.ts` across the two core commits",
		'`LOREM_BUILD_SHA` and core\'s tag as `CORE_TAG`',
		'the CI wrapper runs it a second time',
		'`--rollback` checks out the site\'s previous commit and the core it records',
		'**Moving the pin**',
		'git add core'
	]) {
		assert.ok(pinned.includes(fact), `the section does not say: ${fact}`);
	}
});

test('E44 R7: CI runs both deploy test scripts', () => {
	const ci = read('.github/workflows/ci.yml');
	assert.match(ci, /^ {6}- run: bash deploy\/ci-deploy\.test\.sh$/m);
	assert.match(ci, /^ {6}- run: bash deploy\/deploy\.test\.sh$/m);
	assert.match(ci, /runs-on: ubuntu-latest/);
});
