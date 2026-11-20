import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { SKIN_PREFIX, TERMS } from '../scripts/check-neutral';
import { checkSkinRoot } from '../scripts/check-skin';
import { loadSkinDir } from './lib/skin/load';

// E45: the split into a core repository and a skin repository, the files the
// skin repository starts with, and the procedure that cuts the site over.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const SPLIT = join(ROOT, 'scripts/split-export.sh');
const STARTER = 'skin-repository';
const noSkin = !existsSync(join(ROOT, SKIN_PREFIX)) && 'this tree carries no community skin';
// An exported core carries no starter files; a skin repository's CI puts its own
// .github back at this path so these tests check the guardrail it ships.
const noStarter =
	!existsSync(join(ROOT, STARTER)) && 'this tree carries no skin-repository starter files';

type ChangedFile = { filename: string; previous_filename?: string };
type Review = { user: { login: string } | null; state: string; commit_id: string };
type Decision = { pass: boolean; reason: string };
type Guardrail = {
	decide(input: {
		author: string;
		headSha: string;
		files: readonly ChangedFile[];
		reviews: readonly Review[];
		maintainers: readonly string[];
		submodules: readonly string[];
	}): Decision;
	protectedChanges(files: readonly ChangedFile[], submodules: readonly string[]): string[];
	submodulePaths(text: string | null): string[];
	run(input: {
		get: (path: string, options?: { raw?: boolean }) => Promise<unknown>;
		repo: string;
		number: number;
	}): Promise<Decision>;
};
const GUARDRAIL = join(ROOT, STARTER, '.github/guardrail/guardrail.mjs');
const guardrail: Guardrail = noStarter
	? (undefined as unknown as Guardrail)
	: await import(pathToFileURL(GUARDRAIL).href);
const { decide, protectedChanges, run, submodulePaths } = guardrail ?? ({} as Guardrail);

const scratch: string[] = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'e45-'));
	scratch.push(dir);
	return dir;
}

const IDENT = {
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.org',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.org',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1'
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();

function write(root: string, files: Record<string, string>) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}

function commitAll(dir: string, message: string): string {
	git(dir, 'add', '-A');
	git(dir, 'commit', '--quiet', '--message', message);
	return git(dir, 'rev-parse', 'HEAD');
}

/** Every entry under a directory as `path mode digest`, links by their text. */
function snapshot(root: string, dir = ''): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true })
		.flatMap((e) => {
			const path = dir ? `${dir}/${e.name}` : e.name;
			const full = join(root, path);
			const mode = (lstatSync(full).mode & 0o777).toString(8);
			if (e.isDirectory()) return [`${path}/ ${mode}`, ...snapshot(root, path)];
			const body = e.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
			return [`${path} ${mode} ${createHash('sha256').update(body).digest('hex')}`];
		})
		.sort();
}

const split = (cwd: string, ...args: string[]) =>
	spawnSync('bash', [SPLIT, ...args], { cwd, encoding: 'utf8' });

// A small repository in the monolith's layout: core files, the default skin,
// one community skin, the starter files, and the real neutral check.
function monolith(extra: Record<string, string> = {}): string {
	const dir = tmp();
	git(dir, 'init', '--quiet', '--initial-branch=main');
	write(dir, {
		'README.md': 'core readme\n',
		'.gitignore': 'ignored.env\n',
		'scripts/check-neutral.ts': read('scripts/check-neutral.ts'),
		'scripts/run.sh': '#!/bin/sh\necho run\n',
		'skin/default/skin.yaml': 'id: default\n',
		'skin/acme/skin.yaml': `id: acme\nname: ${TERMS[0]} alumni\n`,
		'skin/acme/deploy/nginx/site.conf': 'server {}\n',
		'skin/acme/RUNBOOK.md': '# runbook\n',
		[`${STARTER}/.github/workflows/ci.yml`]: 'name: CI\n',
		[`${STARTER}/.github/workflows/guardrail.yml`]: 'name: Guardrail\n',
		[`${STARTER}/.github/guardrail/guardrail.mjs`]: 'export {};\n',
		[`${STARTER}/.github/pull_request_template.md`]: '## What changed\n',
		...extra
	});
	chmodSync(join(dir, 'scripts/run.sh'), 0o755);
	symlinkSync('README.md', join(dir, 'LINK.md'));
	commitAll(dir, 'monolith');
	return dir;
}

// ---------------------------------------------------------------------------
// 1: scripts/split-export.sh
// ---------------------------------------------------------------------------

test('E45 R1: split-export writes core without the community skin or the starter files, and skin with both at its root', () => {
	const repo = monolith();
	const out = join(tmp(), 'split');
	const r = split(repo, out);
	assert.equal(r.status, 0, r.stderr);
	const core = snapshot(join(out, 'core')).map((l) => l.split(' ')[0]);
	assert.ok(core.includes('README.md') && core.includes('skin/default/skin.yaml'));
	assert.ok(core.includes('scripts/check-neutral.ts') && core.includes('LINK.md'));
	assert.ok(!core.some((p) => p.startsWith('skin/acme')), 'the community skin is in core');
	assert.ok(!core.some((p) => p.startsWith(STARTER)), 'the starter files are in core');
	const skin = snapshot(join(out, 'skin')).map((l) => l.split(' ')[0]);
	assert.deepEqual(
		skin.filter((p) => !p.endsWith('/')),
		[
			'.github/guardrail/guardrail.mjs',
			'.github/pull_request_template.md',
			'.github/workflows/ci.yml',
			'.github/workflows/guardrail.yml',
			'RUNBOOK.md',
			'deploy/nginx/site.conf',
			'skin.yaml'
		]
	);
	assert.equal((lstatSync(join(out, 'core/scripts/run.sh')).mode & 0o111) !== 0, true);
	assert.equal(readlinkSync(join(out, 'core/LINK.md')), 'README.md');
});

test('E45 R1: split-export reads the commit, never the working tree: untracked, ignored and uncommitted changes stay out', () => {
	const repo = monolith();
	write(repo, {
		'untracked.txt': 'untracked\n',
		'ignored.env': 'SECRET=1\n',
		'README.md': 'edited, not committed\n',
		'skin/acme/untracked.yaml': 'x\n',
		[`${STARTER}/untracked.md`]: 'x\n'
	});
	const out = join(tmp(), 'split');
	const r = split(repo, out);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(readFileSync(join(out, 'core/README.md'), 'utf8'), 'core readme\n');
	for (const path of [
		'core/untracked.txt',
		'core/ignored.env',
		'skin/untracked.yaml',
		'skin/untracked.md'
	]) {
		assert.ok(!existsSync(join(out, path)), `${path} leaked into the export`);
	}
});

test('E45 R1: two runs on one commit write identical trees, and a named commit exports that commit', () => {
	const repo = monolith();
	const first = git(repo, 'rev-parse', 'HEAD');
	write(repo, { 'README.md': 'second\n' });
	commitAll(repo, 'second');
	const [a, b, old] = [join(tmp(), 'a'), join(tmp(), 'b'), join(tmp(), 'old')];
	assert.equal(split(repo, a).status, 0);
	assert.equal(split(repo, b).status, 0);
	assert.deepEqual(snapshot(a), snapshot(b));
	assert.equal(split(repo, old, first).status, 0);
	assert.equal(readFileSync(join(old, 'core/README.md'), 'utf8'), 'core readme\n');
	assert.notDeepEqual(snapshot(join(a, 'core')), snapshot(join(old, 'core')));
});

test('E45 R1: a core tree that is not neutral is refused, named, and removed', () => {
	const repo = monolith({ 'docs/leak.md': `hosted by ${TERMS[0]}\n` });
	const out = join(tmp(), 'split');
	const r = split(repo, out);
	assert.equal(r.status, 1);
	assert.match(r.stderr, /docs\/leak\.md:1:/);
	assert.match(r.stderr, /is not neutral/);
	assert.doesNotMatch(r.stdout, /exported/);
	assert.ok(!existsSync(join(out, 'core')) && !existsSync(join(out, 'skin')));
});

test('E45 R1: split-export refuses a non-empty target, a skin that collides with a starter file, and a missing starter', () => {
	const repo = monolith();
	const busy = tmp();
	write(busy, { 'keep.txt': 'x' });
	const r1 = split(repo, busy);
	assert.equal(r1.status, 1);
	assert.match(r1.stderr, /not an empty directory/);
	assert.equal(readFileSync(join(busy, 'keep.txt'), 'utf8'), 'x');

	const clash = monolith({ 'skin/acme/.github/workflows/ci.yml': 'mine\n' });
	const r2 = split(clash, join(tmp(), 'split'));
	assert.equal(r2.status, 1);
	assert.match(r2.stderr, /both carry: \.github\/workflows\/ci\.yml/);

	const bare = monolith();
	git(bare, 'rm', '-r', '--quiet', STARTER);
	git(bare, 'commit', '--quiet', '--message', 'no starter');
	const r3 = split(bare, join(tmp(), 'split'));
	assert.equal(r3.status, 1);
	assert.match(r3.stderr, /no skin-repository\/ directory/);
});

test(
	'E45 R1+R2: this tree exports cleanly, its core is neutral, and the starter files land at the skin root',
	{ skip: noSkin || noStarter },
	() => {
		// The working tree as a commit, through a scratch index, so the test covers
		// the files as they stand rather than the last commit. No ref moves.
		const index = join(tmp(), 'index');
		const env = { ...process.env, ...IDENT, GIT_INDEX_FILE: index };
		const run = (...args: string[]) =>
			execFileSync('git', args, { cwd: ROOT, env, encoding: 'utf8' }).trim();
		run('read-tree', 'HEAD');
		run('add', '-A');
		const commit = run('commit-tree', run('write-tree'), '-p', 'HEAD', '-m', 'e45 export test');
		const out = join(tmp(), 'split');
		const r = split(ROOT, out, commit);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /neutral: no file in .*\/core names the community/);
		const skin = join(out, 'skin');
		for (const path of [
			'.github/workflows/ci.yml',
			'.github/workflows/guardrail.yml',
			'.github/guardrail/guardrail.mjs',
			'.github/pull_request_template.md'
		]) {
			assert.equal(readFileSync(join(skin, path), 'utf8'), read(`${STARTER}/${path}`), path);
		}
		for (const path of ['skin.yaml', 'theme.css', 'MAINTAINERS', 'RUNBOOK.md']) {
			assert.ok(existsSync(join(skin, path)), `${path} is not at the skin root`);
		}
		assert.ok(!existsSync(join(out, 'core', SKIN_PREFIX)));
		assert.ok(!existsSync(join(out, 'core', STARTER)));
		assert.ok(existsSync(join(out, 'core/scripts/check-skin.ts')));
	}
);

// ---------------------------------------------------------------------------
// 2: the skin repository's CI
// ---------------------------------------------------------------------------

type Step = {
	name?: string;
	if?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
	['working-directory']?: string;
};
type Job = { needs?: string; if?: string; steps: Step[] };
type Workflow = {
	on: Record<string, unknown>;
	concurrency?: Record<string, unknown>;
	jobs: Record<string, Job & { concurrency?: Record<string, unknown> }>;
};
const ci: Workflow = noStarter
	? (undefined as unknown as Workflow)
	: parse(read(`${STARTER}/.github/workflows/ci.yml`));
const step = (job: Job, name: string) => {
	const s = job.steps.find((x) => x.name === name);
	assert.ok(s, `no step named ${name}`);
	return s;
};
const bash = (block: string, cwd: string, env: Record<string, string> = {}) =>
	spawnSync('bash', ['-e', '-c', block], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, ...IDENT, ...env }
	});

test(
	'E45 R2: skin CI checks out with submodules, validates, builds with the skin as context and runs core tests',
	{ skip: noStarter },
	() => {
		assert.deepEqual(Object.keys(ci.on).sort(), ['pull_request', 'push']);
		const { check } = ci.jobs;
		const checkout = check.steps[0];
		assert.match(checkout.uses ?? '', /^actions\/checkout@[0-9a-f]{40}$/);
		assert.equal(checkout.with?.submodules, true);
		const validate = step(check, "Validate the skin with core's validator");
		assert.equal(validate['working-directory'], 'core');
		assert.match(validate.run ?? '', /^id=\$\(node --import tsx scripts\/check-skin\.ts \.\.\)$/m);
		const build = step(check, 'Build the image with this skin as its context');
		assert.match(build.run ?? '', /docker build --build-context skin=\. .* core$/);
		const tests = step(check, "Core's test suite against this skin");
		assert.equal(tests['working-directory'], 'core');
		assert.match(tests.run ?? '', /pnpm test$/m);
		const names = check.steps.map((s) => s.name ?? s.uses ?? s.run);
		const at = (n: string) => names.indexOf(n);
		assert.ok(
			at('Core is pinned to a release tag') < at("Validate the skin with core's validator")
		);
		assert.ok(
			at("Validate the skin with core's validator") <
				at('Build the image with this skin as its context')
		);
		assert.ok(
			at('Build the image with this skin as its context') <
				at("Core's test suite against this skin")
		);
	}
);

test(
	'E45 R2: the pin check passes only a commit that is exactly a vX.Y.Z tag, lightweight or annotated',
	{ skip: noStarter },
	() => {
		const block = step(ci.jobs.check, 'Core is pinned to a release tag').run ?? '';
		const origin = tmp();
		git(origin, 'init', '--quiet', '--initial-branch=main');
		const commit = (n: string) => {
			write(origin, { 'f.txt': n });
			return commitAll(origin, n);
		};
		const light = commit('1');
		git(origin, 'tag', 'v1.2.3');
		const annotated = commit('2');
		git(origin, 'tag', '-a', 'v1.3.0', '-m', 'release');
		const rc = commit('3');
		git(origin, 'tag', 'v1.4.0-rc1');
		const loose = commit('4');
		const site = tmp();
		git(site, 'clone', '--quiet', origin, 'core');
		for (const [sha, ok, tag] of [
			[light, true, 'v1.2.3'],
			[annotated, true, 'v1.3.0'],
			[rc, false, ''],
			[loose, false, '']
		] as const) {
			git(join(site, 'core'), 'checkout', '--quiet', '--detach', sha);
			const r = bash(block, site);
			assert.equal(r.status === 0, ok, `${sha}: ${r.stdout}${r.stderr}`);
			if (ok)
				assert.match(
					r.stdout,
					new RegExp(`core is pinned at ${tag.replace(/\./g, '\\.')} \\(${sha}\\)`)
				);
			else
				assert.match(
					r.stdout,
					new RegExp(`::error::core is pinned at ${sha}, which is not a v\\{major\\}`)
				);
		}
	}
);

test(
	'E45 R2: a refused skin fails the validate step instead of writing an empty id',
	{ skip: noStarter },
	() => {
		const block = step(ci.jobs.check, "Validate the skin with core's validator").run ?? '';
		const bin = tmp();
		write(bin, { node: '#!/bin/sh\necho "skin.yaml: refused" >&2\nexit 1\n' });
		chmodSync(join(bin, 'node'), 0o755);
		const output = join(tmp(), 'out');
		const r = bash(block, tmp(), { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output });
		assert.notEqual(r.status, 0);
		assert.ok(!existsSync(output) || !readFileSync(output, 'utf8').includes('id='));
	}
);

test(
	"E45 R2: the test step puts this skin at core's skin/<id> and its .github at skin-repository, staged, syncs, then runs pnpm test and the dependency-path probe",
	{ skip: noStarter },
	() => {
		const block = step(ci.jobs.check, "Core's test suite against this skin").run ?? '';
		const site = tmp();
		write(site, {
			'skin.yaml': 'id: acme\n',
			'theme.css': ':root {}\n',
			'copy/landing.md': 'hi\n',
			'static/favicon.ico': 'ico',
			'RUNBOOK.md': '# runbook\n',
			'deploy/nginx/site.conf': 'server {}\n',
			MAINTAINERS: 'someone\n',
			'.github/guardrail/guardrail.mjs': 'export {};\n',
			'core/skin/default/skin.yaml': 'id: default\n'
		});
		const core = join(site, 'core');
		git(core, 'init', '--quiet');
		commitAll(core, 'core');
		const bin = tmp();
		const seen = join(bin, 'seen');
		// Records each call, and the staged files at the moment the tests start.
		write(bin, {
			pnpm: `#!/bin/sh\necho "$*" >> ${seen}.calls\n[ "$1" = test ] && git ls-files skin skin-repository > ${seen}\nexit 0\n`,
			node: `#!/bin/sh\necho "node $*" >> ${seen}.calls\nexit 0\n`
		});
		chmodSync(join(bin, 'pnpm'), 0o755);
		chmodSync(join(bin, 'node'), 0o755);
		const r = bash(block, core, { PATH: `${bin}:${process.env.PATH}`, SKIN_ID: 'acme' });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(
			readFileSync(seen, 'utf8').trim().split('\n').sort(),
			[
				'skin/acme/MAINTAINERS',
				'skin/acme/RUNBOOK.md',
				'skin/acme/copy/landing.md',
				'skin/acme/deploy/nginx/site.conf',
				'skin/acme/skin.yaml',
				'skin/acme/static/favicon.ico',
				'skin/acme/theme.css',
				'skin/default/skin.yaml'
			]
				.concat('skin-repository/.github/guardrail/guardrail.mjs')
				.sort()
		);
		assert.equal(
			readFileSync(`${seen}.calls`, 'utf8'),
			'exec svelte-kit sync\ntest\nnode --test scripts/e45-review-external-dependency-path.test.mjs\n'
		);
	}
);

test(
	'E45 R2: on a push to main skin CI deploys through core/deploy/ci-deploy.sh with the four DEPLOY_* secrets, and skips green without them',
	{ skip: noStarter },
	() => {
		const { check, deploy } = ci.jobs;
		assert.equal(deploy.needs, 'check');
		// Only the check job cancels: a workflow-level group would take the
		// older run's deploy down with it.
		assert.equal(ci.concurrency, undefined);
		assert.equal(check.concurrency?.['cancel-in-progress'], true);
		assert.deepEqual(deploy.concurrency, { group: 'deploy', 'cancel-in-progress': false });
		assert.equal(deploy.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
		assert.equal(deploy.steps[0].with?.submodules, true);
		const go = step(deploy, 'Deploy');
		assert.match(go.run ?? '', /^\s*core\/deploy\/ci-deploy\.sh ssh /m);
		assert.deepEqual(Object.values(go.env ?? {}).sort(), [
			'${{ secrets.DEPLOY_HOST }}',
			'${{ secrets.DEPLOY_KNOWN_HOSTS }}',
			'${{ secrets.DEPLOY_SSH_KEY }}',
			'${{ secrets.DEPLOY_USER }}'
		]);
		assert.equal(go.if, "steps.gate.outputs.ready == 'true'");
		const gate = step(deploy, 'Deploy target configured?');
		assert.deepEqual(gate.env, {
			KEY: '${{ secrets.DEPLOY_SSH_KEY }}',
			HOST: '${{ secrets.DEPLOY_HOST }}',
			KNOWN_HOSTS: '${{ secrets.DEPLOY_KNOWN_HOSTS }}'
		});
		for (const [env, ready] of [
			[{ KEY: '', HOST: '', KNOWN_HOSTS: '' }, 'false'],
			[{ KEY: 'k', HOST: '', KNOWN_HOSTS: 'kh' }, 'false'],
			[{ KEY: 'k', HOST: 'h', KNOWN_HOSTS: 'kh' }, 'true']
		] as const) {
			const output = join(tmp(), 'out');
			const r = bash(gate.run ?? '', tmp(), { ...env, GITHUB_OUTPUT: output });
			assert.equal(r.status, 0);
			assert.equal(readFileSync(output, 'utf8'), `ready=${ready}\n`);
		}
	}
);

test("E45 R2: check-skin validates a site root holding core and scripts, the way the image takes it, and names the site's path", () => {
	const site = tmp();
	cpSync(join(ROOT, 'skin/default'), site, { recursive: true });
	write(site, {
		'core/build/index.js': 'export {};\n',
		'.github/guardrail/guardrail.mjs': 'export {};\n',
		'deploy/nginx/site.conf': 'server {}\n'
	});
	assert.throws(() => loadSkinDir(site), /a code file/);
	assert.equal(checkSkinRoot(site).skin.id, 'default');
	const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-skin.ts', site], {
		cwd: ROOT,
		encoding: 'utf8'
	});
	assert.equal(cli.status, 0, cli.stderr);
	assert.equal(cli.stdout, 'default\n');

	write(site, { 'skin.yaml': `${readFileSync(join(site, 'skin.yaml'), 'utf8')}colour: red\n` });
	const bad = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-skin.ts', site], {
		cwd: ROOT,
		encoding: 'utf8'
	});
	assert.equal(bad.status, 1);
	assert.ok(bad.stderr.startsWith(`${site}/skin.yaml: colour: found an unknown key`), bad.stderr);
	assert.doesNotMatch(bad.stderr, /check-skin-/);
});

// ---------------------------------------------------------------------------
// 3: the review guardrail
// ---------------------------------------------------------------------------

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const review = (login: string, state: string, commit_id = HEAD) => ({
	user: { login },
	state,
	commit_id
});
const base = {
	author: 'member',
	headSha: HEAD,
	files: [{ filename: 'copy/landing-hero.md' }],
	reviews: [] as ReturnType<typeof review>[],
	maintainers: ['keeper', 'Second'],
	submodules: ['core']
};

test('E45 R3: no reviews fails', { skip: noStarter }, () => {
	const d = decide(base);
	assert.equal(d.pass, false);
	assert.match(d.reason, /member is not in MAINTAINERS/);
});

test('E45 R3: an approval from a non-maintainer fails', { skip: noStarter }, () => {
	assert.equal(decide({ ...base, reviews: [review('friend', 'APPROVED')] }).pass, false);
});

test(
	'E45 R3: a maintainer approval on an older commit fails, and says so',
	{ skip: noStarter },
	() => {
		const d = decide({ ...base, reviews: [review('keeper', 'APPROVED', OLD)] });
		assert.equal(d.pass, false);
		assert.match(d.reason, /approval of an earlier commit does not count/);
	}
);

test(
	'E45 R3: a maintainer approval on the head passes, matched without regard to case',
	{ skip: noStarter },
	() => {
		const d = decide({ ...base, reviews: [review('second', 'APPROVED')] });
		assert.equal(d.pass, true);
		assert.match(d.reason, /approved on aaaaaaa by maintainer second/);
	}
);

test(
	'E45 R3: a later request for changes or a dismissal withdraws an approval; a comment does not',
	{ skip: noStarter },
	() => {
		const withdrawn = [review('keeper', 'APPROVED'), review('keeper', 'CHANGES_REQUESTED')];
		assert.equal(decide({ ...base, reviews: withdrawn }).pass, false);
		assert.equal(decide({ ...base, reviews: [review('keeper', 'DISMISSED')] }).pass, false);
		assert.equal(
			decide({ ...base, reviews: [review('keeper', 'APPROVED'), review('keeper', 'COMMENTED')] })
				.pass,
			true
		);
	}
);

test(
	"E45 R3: a maintainer's own pull request passes without review, protected path or not",
	{ skip: noStarter },
	() => {
		for (const files of [
			[{ filename: 'copy/landing-hero.md' }],
			[{ filename: 'deploy/nginx/site.conf' }],
			[{ filename: '.github/workflows/guardrail.yml' }],
			[{ filename: '.gitmodules' }],
			[{ filename: 'MAINTAINERS' }],
			[{ filename: 'core' }]
		]) {
			const d = decide({ ...base, author: 'Keeper', files, maintainers: ['keeper'] });
			assert.equal(d.pass, true, `${JSON.stringify(files)} failed for the sole maintainer`);
			assert.match(d.reason, /opened by maintainer Keeper/);
		}
	}
);

test(
	"E45 R3: a non-maintainer's protected-path change fails until a maintainer approves, and names the path",
	{ skip: noStarter },
	() => {
		for (const files of [
			[{ filename: 'deploy/nginx/site.conf' }],
			[{ filename: 'notes/site.conf', previous_filename: 'deploy/site.conf' }]
		]) {
			const alone = decide({ ...base, files });
			assert.equal(alone.pass, false);
			assert.match(alone.reason, /deploy\/(nginx\/)?site\.conf/);
			const self = decide({ ...base, files, reviews: [review('member', 'APPROVED')] });
			assert.equal(self.pass, false, 'a non-maintainer approved their own pull request');
			assert.equal(decide({ ...base, files, reviews: [review('keeper', 'APPROVED')] }).pass, true);
		}
	}
);

test('E45 R3: an empty MAINTAINERS fails every pull request', { skip: noStarter }, () => {
	const d = decide({
		...base,
		author: 'keeper',
		maintainers: [],
		reviews: [review('second', 'APPROVED')]
	});
	assert.equal(d.pass, false);
	assert.match(d.reason, /lists nobody/);
});

test(
	'E45 R3: protected paths come from the base .gitmodules, and every submodule counts as the pin',
	{ skip: noStarter },
	() => {
		const modules = submodulePaths(
			'[submodule "core"]\n\tpath = core\n\turl = https://example.org/core.git\n[submodule "x"]\n  path = vendor/x\n'
		);
		assert.deepEqual(modules, ['core', 'vendor/x']);
		assert.deepEqual(
			protectedChanges(
				[{ filename: 'vendor/x' }, { filename: 'copy/a.md' }, { filename: 'core' }],
				modules
			),
			['core', 'vendor/x']
		);
	}
);

/** A stub API that answers the guardrail's reads and records every path asked for. */
function api({
	author,
	files,
	reviews,
	maintainers
}: {
	author: string;
	files: { filename: string }[];
	reviews: ReturnType<typeof review>[];
	maintainers: Record<string, string>;
}) {
	const asked: string[] = [];
	const at = '/repos/o/site';
	const get = async (path: string, { raw = false } = {}) => {
		asked.push(path);
		const url = new URL(path, 'https://api.invalid');
		const page = Number(url.searchParams.get('page') ?? 1);
		const slice = <T>(all: T[]) => all.slice((page - 1) * 100, page * 100);
		if (url.pathname === `${at}/pulls/7`) {
			return {
				user: { login: author },
				head: { sha: HEAD, ref: 'feature' },
				base: { ref: 'main' },
				changed_files: files.length
			};
		}
		if (url.pathname === `${at}/pulls/7/files`) return slice(files);
		if (url.pathname === `${at}/pulls/7/reviews`) return slice(reviews);
		if (url.pathname === `${at}/contents/MAINTAINERS`) {
			assert.equal(raw, true);
			return maintainers[url.searchParams.get('ref') ?? ''] ?? null;
		}
		if (url.pathname === `${at}/contents/.gitmodules`) return '[submodule "core"]\n\tpath = core\n';
		throw new Error(`unexpected ${path}`);
	};
	return { get, asked };
}

test(
	'E45 R3: MAINTAINERS is read from the base branch, so a pull request cannot add its own author',
	{ skip: noStarter },
	async () => {
		// The pull request lists its own approver; only main's list may count them.
		const stub = api({
			author: 'member',
			files: [{ filename: 'MAINTAINERS' }],
			reviews: [review('friend', 'APPROVED')],
			maintainers: { main: 'keeper\n', feature: 'keeper\nfriend\n', [HEAD]: 'keeper\nfriend\n' }
		});
		const d = await run({ get: stub.get, repo: 'o/site', number: 7 });
		assert.equal(d.pass, false);
		const contents = stub.asked.filter((p) => p.includes('/contents/'));
		assert.deepEqual(contents.sort(), [
			'/repos/o/site/contents/.gitmodules?ref=main',
			'/repos/o/site/contents/MAINTAINERS?ref=main'
		]);

		// The same approval passes once main lists the approver. An author passes
		// alone only when main lists them, never when the pull request adds them.
		const listed = api({
			author: 'member',
			files: [{ filename: 'MAINTAINERS' }],
			reviews: [review('friend', 'APPROVED')],
			maintainers: { main: 'keeper\nfriend\n' }
		});
		assert.equal((await run({ get: listed.get, repo: 'o/site', number: 7 })).pass, true);
		const author = api({
			author: 'member',
			files: [{ filename: 'copy/a.md' }],
			reviews: [],
			maintainers: { main: 'keeper\nmember\n' }
		});
		assert.equal((await run({ get: author.get, repo: 'o/site', number: 7 })).pass, true);
		const added = api({
			author: 'member',
			files: [{ filename: 'MAINTAINERS' }],
			reviews: [],
			maintainers: { main: 'keeper\n', [HEAD]: 'keeper\nmember\n' }
		});
		assert.equal((await run({ get: added.get, repo: 'o/site', number: 7 })).pass, false);
	}
);

test(
	'E45 R3: the guardrail reads every page of files and reviews, and fails closed when GitHub lists fewer files than it counts',
	{ skip: noStarter },
	async () => {
		const files = Array.from({ length: 150 }, (_, i) => ({ filename: `copy/${i}.md` }));
		files[120] = { filename: 'deploy/late.conf' };
		const reviews = [
			...Array.from({ length: 100 }, () => review('friend', 'COMMENTED')),
			review('keeper', 'APPROVED')
		];
		const stub = api({
			author: 'member',
			files,
			reviews: reviews.slice(0, 100),
			maintainers: { main: 'keeper\nsecond\n' }
		});
		const d = await run({ get: stub.get, repo: 'o/site', number: 7 });
		assert.equal(d.pass, false);
		assert.match(d.reason, /deploy\/late\.conf/);
		const approved = api({
			author: 'member',
			files,
			reviews,
			maintainers: { main: 'keeper\nsecond\n' }
		});
		assert.equal((await run({ get: approved.get, repo: 'o/site', number: 7 })).pass, true);

		const short = api({
			author: 'keeper',
			files: [],
			reviews: [],
			maintainers: { main: 'keeper\n' }
		});
		const get = async (path: string, o?: { raw?: boolean }) =>
			path.endsWith('/pulls/7')
				? { ...((await short.get(path, o)) as object), changed_files: 3001 }
				: short.get(path, o);
		const d2 = await run({ get, repo: 'o/site', number: 7 });
		assert.equal(d2.pass, false);
		assert.match(d2.reason, /listed 0 of 3001 changed files/);
	}
);

test(
	'E45 R3: the guardrail script, run as the workflow runs it, fails the job against a live API until a maintainer approves',
	{ skip: noStarter },
	async () => {
		let reviews: ReturnType<typeof review>[] = [];
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? '', 'http://x');
			assert.equal(req.headers.authorization, 'Bearer t0ken');
			const body = (() => {
				if (url.pathname === '/repos/o/site/pulls/7') {
					return {
						user: { login: 'member' },
						head: { sha: HEAD },
						base: { ref: 'main' },
						changed_files: 1
					};
				}
				if (url.pathname === '/repos/o/site/pulls/7/files') return [{ filename: 'deploy/x.conf' }];
				if (url.pathname === '/repos/o/site/pulls/7/reviews') return reviews;
				if (
					url.pathname === '/repos/o/site/contents/MAINTAINERS' &&
					url.searchParams.get('ref') === 'main'
				) {
					assert.equal(req.headers.accept, 'application/vnd.github.raw+json');
					return 'keeper\n';
				}
				return undefined;
			})();
			if (body === undefined) {
				res.writeHead(404).end('{}');
				return;
			}
			res.writeHead(200).end(typeof body === 'string' ? body : JSON.stringify(body));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const { port } = server.address() as { port: number };
			const event = join(tmp(), 'event.json');
			writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
			const script = join(ROOT, STARTER, '.github/guardrail/guardrail.mjs');
			const env = {
				...process.env,
				GITHUB_TOKEN: 't0ken',
				GITHUB_REPOSITORY: 'o/site',
				GITHUB_EVENT_PATH: event,
				GITHUB_API_URL: `http://127.0.0.1:${port}`
			};
			const runIt = () =>
				promisify(execFile)(process.execPath, [script], { env }).then(
					(r) => ({ code: 0, out: r.stdout }),
					(e: { code: number; stdout: string }) => ({ code: e.code, out: e.stdout })
				);
			const red = await runIt();
			assert.equal(red.code, 1);
			assert.match(red.out, /^::error title=Maintainer approval required::.*deploy\/x\.conf/m);
			reviews = [review('keeper', 'APPROVED')];
			const green = await runIt();
			assert.equal(green.code, 0, green.out);
			assert.match(green.out, /guardrail: pass: approved on aaaaaaa by maintainer keeper/);
		} finally {
			server.close();
		}
	}
);

test(
	'E45 R3: the guardrail workflow runs on pull requests and reviews, from the base branch, with read-only permissions',
	{ skip: noStarter },
	() => {
		const wf = parse(read(`${STARTER}/.github/workflows/guardrail.yml`)) as {
			on: Record<string, { types: string[] }>;
			permissions: Record<string, string>;
			jobs: Record<string, Job>;
		};
		assert.deepEqual(Object.keys(wf.on).sort(), ['pull_request', 'pull_request_review']);
		assert.ok(wf.on.pull_request.types.includes('synchronize'));
		assert.ok(
			wf.on.pull_request_review.types.includes('submitted') &&
				wf.on.pull_request_review.types.includes('dismissed')
		);
		assert.deepEqual(wf.permissions, { contents: 'read', 'pull-requests': 'read' });
		const [checkout, guard] = Object.values(wf.jobs)[0].steps;
		assert.equal(checkout.with?.ref, '${{ github.event.pull_request.base.ref }}');
		assert.equal(guard.run, 'node .github/guardrail/guardrail.mjs');
	}
);

// ---------------------------------------------------------------------------
// 4: the pull request template and docs/skin-repository.md
// ---------------------------------------------------------------------------

test(
	'E45 R4: the pull request template asks what changed, for a screenshot, and lists the reviews the guardrail expects',
	{ skip: noStarter },
	() => {
		const t = read(`${STARTER}/.github/pull_request_template.md`);
		assert.match(t, /^## What changed$/m);
		assert.match(t, /^## Screenshot$/m);
		assert.match(t, /visual change/);
		const boxes = t.split('\n').filter((l) => l.startsWith('- [ ] '));
		assert.ok(boxes.length >= 2);
		for (const name of [
			'MAINTAINERS',
			'latest commit',
			'`deploy/`',
			'`.github/`',
			'`.gitmodules`',
			'`core` pin'
		]) {
			assert.ok(
				boxes.some((b) => b.includes(name)),
				`no checkbox names ${name}`
			);
		}
	}
);

test('E45 R4: docs/skin-repository.md covers creation, each workflow, the org settings and what the free plan leaves unenforced', () => {
	const page = read('docs/skin-repository.md');
	const section = (h: string) =>
		page.split(new RegExp(`^## ${h}$`, 'm'))[1]?.split(/^## /m)[0] ?? '';
	assert.match(section('Creating one'), /scripts\/split-export\.sh/);
	assert.match(section('Creating one'), /git submodule add .* core/);
	assert.match(
		section('CI workflow'),
		/DEPLOY_SSH_KEY.*DEPLOY_HOST.*DEPLOY_KNOWN_HOSTS.*DEPLOY_USER/
	);
	assert.match(section('CI workflow'), /`v\{major\}\.\{minor\}\.\{patch\}` tag/);
	assert.match(section('Guardrail workflow'), /from the base branch/);
	assert.match(
		section('Guardrail workflow'),
		/`deploy\/` or `\.github\/`, `\.gitmodules`, `MAINTAINERS`/
	);
	assert.match(section('Organization settings'), /Members hold Read and contribute from forks/);
	assert.match(section('Organization settings'), /only thing standing in for branch protection/);
	const free = section('What the free plan does not enforce');
	for (const fact of [
		'no branch protection',
		'CODEOWNERS',
		'status, not a gate',
		'edit the guardrail workflow'
	]) {
		assert.ok(free.includes(fact), `the free-plan section does not say: ${fact}`);
	}
	assert.match(read('README.md'), /\[Skin repository\]\(docs\/skin-repository\.md\)/);
});

// ---------------------------------------------------------------------------
// 5: the cutover procedure
// ---------------------------------------------------------------------------

test(
	'E45 R5: the runbook carries the cutover: freeze, roster, dump, keys, dev first, production, checks and rollback',
	{ skip: noSkin },
	() => {
		const runbook = read(`${SKIN_PREFIX}RUNBOOK.md`);
		const site = `/web/${SKIN_PREFIX.split('/')[1]}.com`;
		const cutover =
			runbook.split(/^## Cutover to the split repositories$/m)[1]?.split(/^## /m)[0] ?? '';
		assert.ok(cutover, 'no cutover section');
		const steps = [...cutover.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
		assert.deepEqual(steps, [
			'1. Freeze',
			'2. Last roster export',
			'3. Database dump',
			'4. Deploy keys and secrets',
			'5. Dev first',
			'6. Production',
			'7. Rollback',
			'8. Closing the rollback window'
		]);
		const body = (n: number) => cutover.split(/^### /m)[n] ?? '';
		for (let n = 1; n <= 8; n++) assert.match(body(n), /\*\*Check/, `step ${n} has no check`);
		for (const command of [
			'git merge-base --is-ancestor loremlabs/main origin/main',
			'deploy/run.sh sync',
			'pg_dump -h postgres -U "$POSTGRES_USER" -Fc -f /dump/cutover-www.dump',
			'gh repo deploy-key add',
			'gh secret set DEPLOY_SSH_KEY --repo',
			'gh secret delete "$s" --repo ravinald/lorem-host',
			'git config submodule.core.url git@github-core:',
			'git submodule update --init',
			`command="${site}/dev/core/deploy/deploy.sh --yes"`,
			'core/deploy/deploy.sh --yes',
			'SELECT count(*) AS members FROM member',
			'pg_restore -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
			`cat /data/secrets/${site.slice('/web/'.length)}/cutover/www-head`
		]) {
			assert.ok(cutover.includes(command), `the cutover does not write out: ${command}`);
		}
		assert.ok(
			body(5).indexOf('dev.split') > 0 && cutover.indexOf('### 5.') < cutover.indexOf('### 6.')
		);
	}
);
