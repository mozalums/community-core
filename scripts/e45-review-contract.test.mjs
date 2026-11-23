import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, mkdtempSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/** @typedef {{jobs: Record<string, {steps: Array<{uses?: string, with?: {token?: string}}> }>, concurrency?: {'cancel-in-progress'?: boolean | string}}} Workflow */
const root = process.cwd();

// The subjects below, the community skin's runbook and the starter files, leave
// core in the split, so an exported core skips this file and says why.
const communitySkin = readdirSync(join(root, 'skin')).find((s) => s !== 'default');
const subjectAbsent = !communitySkin || !existsSync(join(root, 'skin-repository'));
if (subjectAbsent)
	test(
		'[build] E45 review: contract',
		{ skip: 'the community skin and skin-repository/ leave core in the split' },
		() => {}
	);
else {
	const read = (p) => readFileSync(join(root, p), 'utf8');
	const require = createRequire(join(root, 'package.json'));
	const { parse } = require('yaml');
	/** @type {Workflow} */
	const ci = parse(read('skin-repository/.github/workflows/ci.yml'));
	const docs = read('docs/skin-repository.md');
	const community = readdirSync(join(root, 'skin')).find((s) => s !== 'default');
	const runbook = read(`skin/${community}/RUNBOOK.md`);
	const cutover = runbook.split('## Cutover to the split repositories')[1];
	const { decide } = await import(
		pathToFileURL(join(root, 'skin-repository/.github/guardrail/guardrail.mjs'))
	);

	test('[build] R2/R4: the documented token can read the private skin checkout', () => {
		for (const [name, job] of Object.entries(ci.jobs)) {
			const parent = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
			const usesCoreToken = parent?.with?.token?.includes('secrets.CORE_READ_TOKEN');
			const documentedCoreOnly = /Contents read on core alone/.test(docs);
			assert.equal(
				Boolean(usesCoreToken && documentedCoreOnly),
				false,
				`${name}: actions/checkout uses CORE_READ_TOKEN for the private skin, but the documented token can read core alone`
			);
		}
	});

	test('[build] R2 BRANCH-REGRESSION: the enclosing workflow cannot cancel a deploy on a later main push', () => {
		assert.notEqual(
			ci.concurrency?.['cancel-in-progress'],
			true,
			'workflow concurrency cancels the entire main run, including the deploy job'
		);
	});

	test('[build] R3: a sole maintainer can merge their own pull request, protected path or not', () => {
		const head = 'a'.repeat(40);
		for (const filename of [
			'copy/landing.md',
			'deploy/env.example',
			'.github/workflows/ci.yml',
			'core'
		]) {
			const result = decide({
				author: 'keeper',
				headSha: head,
				files: [{ filename }],
				reviews: [],
				maintainers: ['keeper'],
				submodules: ['core']
			});
			assert.equal(result.pass, true, JSON.stringify(result));
		}
	});

	test('[build] R5: before and after private-field probes agree for correctly migrated data', () => {
		const before = cutover.split('### 3. Database dump')[1].split('### 4.')[0];
		const after = cutover.split('### 5. Dev first')[1].split('### 6.')[0];
		// The header-to-key pairs are migration 13 in release 76356d2.
		const data = {
			'Cell/Mobile Number': 'fixture phone',
			'Postal Address': 'fixture postal',
			'Unisex \nT-Shirt/Hoodie Size': 'fixture size'
		};
		const privateData = {
			cellNumber: data['Cell/Mobile Number'],
			postal: data['Postal Address'],
			sizeUnisex: data['Unisex \nT-Shirt/Hoodie Size']
		};
		const keys = (text, bag) =>
			[...text.matchAll(new RegExp(`\\b${bag}->>\\$\\$([\\s\\S]*?)\\$\\$`, 'g'))].map((m) => m[1]);
		const oldKeys = keys(before, 'data');
		const newKeys = keys(after, 'private_data');
		assert.equal(oldKeys.length, 3);
		assert.equal(newKeys.length, 3);
		const digest = (v) =>
			createHash('md5')
				.update(v ?? '')
				.digest('hex');
		const oldDigests = oldKeys.map((k) => digest(data[k]));
		const newDigests = newKeys.map((k) => digest(privateData[k]));
		assert.deepEqual(
			oldDigests,
			newDigests,
			`legacy keys ${JSON.stringify(oldKeys)} select ${JSON.stringify(oldKeys.map((k) => data[k] ?? null))}`
		);
	});

	test('[build] R5: production rollback leaves the dev forced command pointing at core', () => {
		const rollback = cutover.split('### 7. Rollback')[1];
		const expression = rollback.match(/sudo sed -i '([^']+)'[^`\n]*authorized_keys/)[1];
		const base = `/web/${community}.com`;
		const dev = `command="${base}/dev/core/deploy/deploy.sh --yes" ssh-ed25519 fixture-dev`;
		const production = `command="${base}/www/core/deploy/deploy.sh --yes" ssh-ed25519 fixture-production`;
		const result = spawnSync('sed', ['-e', expression], {
			input: `${dev}\n${production}\n`,
			encoding: 'utf8'
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, `${dev}\n${production.replace('/core/deploy/', '/deploy/')}\n`);
	});

	test('[build] BRANCH-REGRESSION: the new E45 module loads when exported core has no starter files', () => {
		const scratch = mkdtempSync(join(tmpdir(), 'e45-review-core-'));
		try {
			const env = {
				...process.env,
				GIT_INDEX_FILE: join(scratch, 'index'),
				GIT_AUTHOR_NAME: 'Review fixture',
				GIT_AUTHOR_EMAIL: 'fixture@example.org',
				GIT_COMMITTER_NAME: 'Review fixture',
				GIT_COMMITTER_EMAIL: 'fixture@example.org'
			};
			const git = (...args) => {
				const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
				assert.equal(r.status, 0, r.stderr);
				return r.stdout.trim();
			};
			git('read-tree', 'HEAD');
			git('add', '-A');
			const commit = git('commit-tree', git('write-tree'), '-p', 'HEAD', '-m', 'review fixture');
			const output = join(scratch, 'export');
			const exported = spawnSync('bash', ['scripts/split-export.sh', output, commit], {
				cwd: root,
				encoding: 'utf8'
			});
			assert.equal(exported.status, 0, exported.stderr);
			symlinkSync(join(root, 'node_modules'), join(output, 'core/node_modules'));
			const childEnv = { ...process.env };
			delete childEnv.NODE_TEST_CONTEXT;
			const r = spawnSync(
				process.execPath,
				['--import', 'tsx', '--test', join(output, 'core/src/e45-split.test.ts')],
				{ cwd: root, env: childEnv, encoding: 'utf8' }
			);
			assert.equal(r.status, 0, r.stdout + r.stderr);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	test('[build] R5: the documented dev rollback restores a dump saved before dev is overwritten', () => {
		const beforeDev = cutover.split('### 5. Dev first')[0];
		const dumps = [...beforeDev.matchAll(/\bpg_dump[^\n]*\s-f\s+(\/dump\/[^\s"']+)/g)].map(
			(m) => m[1]
		);
		const rollback = cutover.split('### 7. Rollback')[1];
		const productionDump = rollback.match(
			/--no-owner --no-privileges --exit-on-error (\/dump\/[^\s"']+)/
		)[1];
		const devDump = productionDump.replaceAll('www', 'dev');
		assert.ok(
			dumps.includes(devDump),
			`dev rollback restores ${devDump}; pre-cutover dumps are ${JSON.stringify(dumps)}`
		);
	});
}
