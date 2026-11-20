import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parse } from 'yaml';

// E46: the one-commit export and its secret scan, core's own repository files,
// the upgrade check, and the release procedure.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const SPLIT = join(ROOT, 'scripts/split-export.sh');
const UPGRADE = join(ROOT, 'scripts/upgrade-check.sh');
const STARTER = 'skin-repository';
const PINNED = '8.30.1';

// The tree before the split: a community skin committed beside the default.
// Neither an exported core nor a skin repository's CI, which stages its skin
// in core's index without committing it, is that tree.
const unsplit = (() => {
	try {
		const dirs = execFileSync('git', ['ls-tree', '-d', '--name-only', 'HEAD', 'skin/'], {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return dirs.split('\n').some((d) => d && d !== 'skin/default');
	} catch {
		return false;
	}
})();
const notUnsplit = !unsplit && 'this tree has been split: no community skin is committed in it';

const scratch: string[] = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'e46-'));
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

// PATH with no gitleaks on it, then `first` ahead of it.
function pathWith(first?: string): string {
	const rest = (process.env.PATH ?? '')
		.split(delimiter)
		.filter((d) => d && !existsSync(join(d, 'gitleaks')));
	return [...(first ? [first] : []), ...rest].join(delimiter);
}

// A gitleaks that prints `version` and records every call; `leakIn` names the
// tree whose scan reports a finding.
function stubGitleaks(
	version: string,
	leakIn?: 'core' | 'skin'
): { bin: string; calls: () => string[] } {
	const bin = tmp();
	const log = join(bin, 'calls');
	writeFileSync(
		join(bin, 'gitleaks'),
		`#!/bin/sh
printf '%s\\n' "$*" >>'${log}'
case "$1" in
version) echo '${version}' ;;
git)
	for last; do :; done
	case "$last" in */${leakIn ?? '-none-'}) echo 'Finding: REDACTED' >&2; exit 1 ;; esac ;;
esac
`
	);
	chmodSync(join(bin, 'gitleaks'), 0o755);
	return {
		bin,
		calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
	};
}

const AUTHOR = [
	'--author',
	'Release Engineer <release@example.org>',
	'--date',
	'2026-11-19T12:00:00Z'
];

function split(cwd: string, args: string[], path = pathWith()) {
	return spawnSync('bash', [SPLIT, ...args], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, PATH: path }
	});
}

// The monolith's layout, small: core files, the default skin, one community
// skin, the starter files with the guardrail, and the real neutral check.
function monolith(extra: Record<string, string> = {}): string {
	const dir = tmp();
	git(dir, 'init', '--quiet', '--initial-branch=main');
	write(dir, {
		'README.md': 'core readme\n',
		'.gitignore': '*.log\n',
		'scripts/check-neutral.ts': read('scripts/check-neutral.ts'),
		'skin/default/skin.yaml': 'id: default\n',
		'skin/acme/skin.yaml': 'id: acme\n',
		[`${STARTER}/.github/workflows/ci.yml`]: 'name: CI\n',
		[`${STARTER}/.github/workflows/guardrail.yml`]: 'name: Guardrail\n',
		[`${STARTER}/.github/guardrail/guardrail.mjs`]: 'export {};\n',
		...extra
	});
	git(dir, 'add', '-A');
	// Tracked although ignored: the one commit must still carry it.
	write(dir, { 'kept.log': 'tracked on purpose\n' });
	git(dir, 'add', '--force', 'kept.log');
	git(dir, 'commit', '--quiet', '--message', 'monolith');
	return dir;
}

// ---------------------------------------------------------------------------
// 1: --init
// ---------------------------------------------------------------------------

test('E46 R1: --init makes core and skin each a repository of exactly one commit with no remote, authored and dated by the flags', () => {
	const repo = monolith();
	const gl = stubGitleaks(PINNED);
	const out = join(tmp(), 'split');
	const r = split(repo, ['--init', ...AUTHOR, out], pathWith(gl.bin));
	assert.equal(r.status, 0, r.stderr);
	const heads: string[] = [];
	for (const tree of ['core', 'skin']) {
		const dir = join(out, tree);
		assert.equal(git(dir, 'rev-list', '--count', 'HEAD'), '1', `${tree} has more than one commit`);
		assert.equal(git(dir, 'remote'), '', `${tree} has a remote`);
		assert.equal(
			git(dir, 'log', '--format=%an <%ae> %aI | %cn <%ce> %cI'),
			'Release Engineer <release@example.org> 2026-11-19T12:00:00Z | Release Engineer <release@example.org> 2026-11-19T12:00:00Z'
		);
		assert.equal(
			git(dir, 'status', '--porcelain', '--ignored'),
			'',
			`${tree} left a file out of its commit`
		);
		heads.push(git(dir, 'rev-parse', 'HEAD'));
	}
	assert.ok(git(join(out, 'core'), 'ls-files').split('\n').includes('kept.log'));
	assert.match(r.stdout, new RegExp(`core .* one commit ${heads[0]}`));

	const again = join(tmp(), 'split');
	assert.equal(split(repo, ['--init', ...AUTHOR, again], pathWith(gl.bin)).status, 0);
	assert.deepEqual(
		['core', 'skin'].map((t) => git(join(again, t), 'rev-parse', 'HEAD')),
		heads,
		'two runs on one commit made different commits'
	);
});

test('E46 R1: --init refuses a target that already holds a .git, and writes nothing into it', () => {
	const repo = monolith();
	const gl = stubGitleaks(PINNED);
	const target = tmp();
	git(target, 'init', '--quiet');
	const r = split(repo, ['--init', ...AUTHOR, target], pathWith(gl.bin));
	assert.equal(r.status, 1);
	assert.match(r.stderr, /\/\.git exists: the export writes new repositories/);
	assert.deepEqual(readdirSync(target), ['.git']);
	assert.ok(!gl.calls().some((c) => c.startsWith('git ')), 'it scanned something');
});

test('E46 R1: --init needs --author as Name <email> and a date git reads, and neither means anything without it', () => {
	const repo = monolith();
	const gl = stubGitleaks(PINNED);
	const cases: [string[], RegExp][] = [
		[['--init', '--date', '2026-11-19', 'x'], /--init needs --author 'Name <email>'/],
		[['--init', '--author', 'no email', '--date', '2026-11-19', 'x'], /got: no email/],
		[['--init', '--author', 'A <a@example.org>', 'x'], /--init needs --date/],
		[
			['--init', '--author', 'A <a@example.org>', '--date', 'someday', 'x'],
			/--date someday is not a date/
		],
		[['--author', 'A <a@example.org>', 'x'], /without --init there is no commit/]
	];
	for (const [args, message] of cases) {
		const target = join(tmp(), 'split');
		const r = split(
			repo,
			args.map((a) => (a === 'x' ? target : a)),
			pathWith(gl.bin)
		);
		assert.equal(r.status, 1, args.join(' '));
		assert.match(r.stderr, message, args.join(' '));
		assert.ok(!existsSync(target), `${args.join(' ')} wrote the target`);
	}
	assert.equal(split(repo, ['--init', '--bogus', 'x']).status, 2);
});

// ---------------------------------------------------------------------------
// 2: the gitleaks scan
// ---------------------------------------------------------------------------

test('E46 R2: --init scans both new repositories with gitleaks, on its own rules, ignoring any exemption the tree carries', () => {
	const repo = monolith();
	const gl = stubGitleaks(PINNED);
	const out = join(tmp(), 'split');
	const r = split(repo, ['--init', ...AUTHOR, out], pathWith(gl.bin));
	assert.equal(r.status, 0, r.stderr);
	assert.match(
		r.stdout,
		new RegExp(`gitleaks ${PINNED.replace(/\./g, '\\.')}: no findings in core or skin`)
	);
	const scans = gl.calls().filter((c) => c.startsWith('git '));
	assert.equal(scans.length, 2);
	const real = realpathSync(out);
	for (const [i, tree] of ['core', 'skin'].entries()) {
		const args = scans[i].split(' ');
		assert.equal(args.at(-1), join(real, tree));
		for (const flag of ['--redact', '--ignore-gitleaks-allow', '--verbose']) {
			assert.ok(args.includes(flag), `${tree} scanned without ${flag}`);
		}
		const config = args[args.indexOf('--config') + 1];
		const ignore = args[args.indexOf('--gitleaks-ignore-path') + 1];
		for (const path of [config, ignore]) {
			assert.ok(path && !path.startsWith(real), `${tree} scan reads ${path} from the tree`);
		}
	}
	assert.equal(gl.calls()[0], 'version', 'the version was not checked first');
});

test('E46 R2: a gitleaks finding in either tree exits non-zero and removes both trees', () => {
	for (const leakIn of ['core', 'skin'] as const) {
		const repo = monolith();
		const gl = stubGitleaks(PINNED, leakIn);
		const out = join(tmp(), 'split');
		const r = split(repo, ['--init', ...AUTHOR, out], pathWith(gl.bin));
		assert.equal(r.status, 1, leakIn);
		assert.match(r.stderr, new RegExp(`reported findings in ${leakIn} .*both trees removed`));
		assert.doesNotMatch(r.stdout, /exported/);
		assert.ok(!existsSync(join(out, 'core')) && !existsSync(join(out, 'skin')), leakIn);
	}
});

test('E46 R2: the gitleaks version is pinned, and a missing or different one is an error naming it before anything is written', () => {
	assert.match(
		read('scripts/split-export.sh'),
		new RegExp(`^readonly GITLEAKS_VERSION=${PINNED.replace(/\./g, '\\.')}$`, 'm')
	);
	const repo = monolith();
	const missing = join(tmp(), 'split');
	const none = split(repo, ['--init', ...AUTHOR, missing]);
	assert.equal(none.status, 1);
	assert.match(
		none.stderr,
		new RegExp(`gitleaks ${PINNED}.*none is on PATH.*releases/tag/v${PINNED}`)
	);
	assert.ok(!existsSync(missing));

	const old = stubGitleaks('8.29.0');
	const other = join(tmp(), 'split');
	const wrong = split(repo, ['--init', ...AUTHOR, other], pathWith(old.bin));
	assert.equal(wrong.status, 1);
	assert.match(wrong.stderr, new RegExp(`scans with gitleaks ${PINNED}; .*gitleaks is 8\\.29\\.0`));
	assert.ok(!existsSync(other));
	assert.deepEqual(old.calls(), ['version'], 'a wrong version still scanned');

	// Without --init nothing is committed, so nothing is scanned or required.
	assert.equal(split(repo, [join(tmp(), 'split')]).status, 0);
});

// Runs where the pinned gitleaks is installed; the stub tests above cover the
// script's side everywhere else.
const realGitleaks = (() => {
	const r = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
	return r.status === 0 && r.stdout.trim().replace(/^v/, '') === PINNED;
})();

test(
	'E46 R2: the pinned gitleaks refuses a planted key, whatever the tree commits to exempt it',
	{ skip: !realGitleaks && `gitleaks ${PINNED} is not on PATH` },
	() => {
		// Spelled in parts so a scan of this file finds no key in it.
		const key = ['AKIA', 'Z7Q4MW2', 'K9XPLT3B'].join('');
		const secret = ['wJalrXUtnFEMI', '/K7MDENG/bPxRfi', 'CYzR4nd0mK3y9'].join('');
		const repo = monolith({
			'config/aws.ini': `aws_access_key_id = ${key} # gitleaks:allow\naws_secret_access_key = ${secret} # gitleaks:allow\n`,
			'.gitleaks.toml': '[extend]\nuseDefault = true\n[allowlist]\npaths = [".*"]\n',
			'.gitleaksignore': 'config/aws.ini\n'
		});
		const out = join(tmp(), 'split');
		const r = split(repo, ['--init', ...AUTHOR, out], process.env.PATH);
		assert.equal(r.status, 1, r.stdout);
		assert.match(r.stderr, /File:\s+config\/aws\.ini/);
		assert.match(r.stderr, /reported findings in core /);
		assert.ok(!r.stderr.includes(secret), 'the finding was printed unredacted');
		assert.ok(!existsSync(join(out, 'core')));

		const clean = split(monolith(), ['--init', ...AUTHOR, join(tmp(), 'split')], process.env.PATH);
		assert.equal(clean.status, 0, clean.stderr);
	}
);

// ---------------------------------------------------------------------------
// 3: core's repository files and the upgrade job
// ---------------------------------------------------------------------------

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
	steps: Step[];
	services?: Record<string, { image: string }>;
	env?: Record<string, string>;
};
const ci: { jobs: Record<string, Job> } = parse(read('.github/workflows/ci.yml'));

test('E46 R3: core CI runs the gate with the default skin and has no deploy job', () => {
	assert.deepEqual(Object.keys(ci.jobs).sort(), ['check', 'upgrade']);
	const runs = ci.jobs.check.steps.map((s) => s.run ?? '');
	for (const command of ['pnpm check', 'pnpm test', 'pnpm build']) {
		assert.ok(runs.includes(command), `the check job does not run ${command}`);
	}
	const text = read('.github/workflows/ci.yml');
	assert.doesNotMatch(text, /SKIN_DIR/, 'CI selects a skin; the gate runs on the default');
	assert.doesNotMatch(
		text,
		/secrets\.|deploy\/ci-deploy\.sh|DEPLOY_/,
		'CI still reaches for a deploy'
	);
	assert.match(read('package.json'), /"test": "SKIN_DIR=skin\/default /);
});

test('E46 R3: the upgrade job runs the upgrade check on fresh services pinned as compose pins them, with every tag fetched', () => {
	const { upgrade } = ci.jobs;
	const compose = read('docker-compose.yml');
	const pg = compose.match(/^x-postgres-image: &postgres-image (\S+)$/m)?.[1];
	const redis = compose.match(/^ {2}redis:\n {4}image: (\S+)$/m)?.[1];
	assert.ok(pg && redis, 'docker-compose.yml no longer pins postgres and redis where this looks');
	assert.equal(upgrade.services?.postgres.image, pg);
	assert.equal(upgrade.services?.redis.image, redis);
	assert.equal(upgrade.steps[0].with?.['fetch-depth'], 0);
	assert.equal(upgrade.steps.at(-1)?.run, 'bash scripts/upgrade-check.sh "$RUNNER_TEMP/upgrade"');
	for (const name of [
		'POSTGRES_HOST',
		'POSTGRES_DATABASE',
		'POSTGRES_USER',
		'POSTGRES_PASSWORD',
		'REDIS_URL'
	]) {
		assert.ok(upgrade.env?.[name], `the upgrade job sets no ${name}`);
	}
});

// A repository holding upgrade-check.sh and the given tags, each on a commit
// whose `marker` file names it.
function tagged(tags: string[]): string {
	const dir = tmp();
	git(dir, 'init', '--quiet', '--initial-branch=main');
	for (const tag of tags) {
		write(dir, { marker: `${tag}\n` });
		git(dir, 'add', '-A');
		git(dir, 'commit', '--quiet', '--message', tag);
		git(dir, 'tag', tag);
	}
	write(dir, { 'scripts/upgrade-check.sh': read('scripts/upgrade-check.sh'), marker: 'head\n' });
	git(dir, 'add', '-A');
	git(dir, 'commit', '--quiet', '--message', 'under test');
	return dir;
}
const upgradeCheck = (cwd: string, work: string, path = pathWith()) =>
	spawnSync('bash', ['scripts/upgrade-check.sh', work], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, PATH: path }
	});

test('E46 R3: before the first release tag the upgrade check passes and says it found nothing to compare against', () => {
	const repo = tagged(['v1.0.0-rc1', 'release-3', 'v2']);
	const r = upgradeCheck(repo, join(tmp(), 'work'));
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /no v\{major\}\.\{minor\}\.\{patch\} tag to compare against/);
});

test('E46 R3: the upgrade check builds the newest v{major}.{minor}.{patch} tag, and fails naming it when that release does not build', () => {
	const repo = tagged(['v0.9.0', 'v0.10.0', 'v0.11.0-rc1']);
	const stub = tmp();
	writeFileSync(
		join(stub, 'pnpm'),
		`#!/bin/sh\necho "pnpm $* in $(pwd)" >>'${join(stub, 'calls')}'\nexit 1\n`
	);
	chmodSync(join(stub, 'pnpm'), 0o755);
	const work = join(tmp(), 'work');
	const r = upgradeCheck(repo, work, pathWith(stub));
	assert.equal(r.status, 1);
	assert.match(r.stdout, /upgrading a database built by v0\.10\.0 to [0-9a-f]+/);
	assert.match(r.stderr, /v0\.10\.0 does not build/);
	assert.equal(readFileSync(join(work, 'v0.10.0', 'marker'), 'utf8'), 'v0.10.0\n');
	assert.match(
		readFileSync(join(stub, 'calls'), 'utf8'),
		/^pnpm install --frozen-lockfile in .*\/v0\.10\.0$/m
	);

	const busy = tmp();
	const refused = upgradeCheck(repo, busy, pathWith(stub));
	assert.equal(refused.status, 1);
	assert.match(refused.stderr, /already exists: name a new directory/);
});

test('E46 R3: the upgrade check requires the ledger to hold every migration, not only an answering health check', () => {
	const src = read('scripts/upgrade-check.sh');
	assert.match(
		src,
		/import \{ MIGRATIONS \} from '\.\/src\/lib\/server\/migrations\.ts'; console\.log\(MIGRATIONS\.length\)/
	);
	assert.match(src, /SELECT count\(\*\)::int AS n FROM schema_migrations/);
	assert.match(src, /grep -q 'schema\.migrate\.error'/);
	assert.match(src, /curl -fsS "http:\/\/127\.0\.0\.1:\$port\/healthz"/);
	assert.match(src, /export SKIN_DIR=\$released\/skin\/default/);
});

test('E46 R3: CODEOWNERS names a maintainer as custodian of src/lib/server, deploy and .github', () => {
	const maintainers = read('MAINTAINERS')
		.split('\n')
		.map((l) => l.replace(/#.*/, '').trim())
		.filter(Boolean);
	assert.ok(maintainers.length > 0, 'MAINTAINERS lists nobody');
	const owners = new Map(
		read('.github/CODEOWNERS')
			.split('\n')
			.filter((l) => l.trim() && !l.startsWith('#'))
			.map((l) => {
				const [path, ...who] = l.trim().split(/\s+/);
				return [path, who];
			})
	);
	for (const path of ['/src/lib/server/', '/deploy/', '/.github/']) {
		const who = owners.get(path) ?? [];
		assert.ok(who.length > 0, `${path} has no custodian`);
		for (const login of who)
			assert.ok(maintainers.includes(login.replace(/^@/, '')), `${login} is not in MAINTAINERS`);
	}
});

test("E46 R3: the export gives core the starter files' guardrail, replacing any copy core carries, and needs one to give", () => {
	const repo = monolith({
		'.github/workflows/guardrail.yml': 'stale\n',
		MAINTAINERS: 'someone\n'
	});
	const out = join(tmp(), 'split');
	const r = split(repo, [out]);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(
		readFileSync(join(out, 'core/.github/workflows/guardrail.yml'), 'utf8'),
		'name: Guardrail\n'
	);
	assert.equal(
		readFileSync(join(out, 'core/.github/guardrail/guardrail.mjs'), 'utf8'),
		'export {};\n'
	);
	assert.equal(readFileSync(join(out, 'core/MAINTAINERS'), 'utf8'), 'someone\n');

	const bare = monolith();
	git(bare, 'rm', '-r', '--quiet', `${STARTER}/.github/guardrail`);
	git(bare, 'commit', '--quiet', '--message', 'no guardrail');
	const refused = split(bare, [join(tmp(), 'split')]);
	assert.equal(refused.status, 1);
	assert.match(
		refused.stderr,
		/has no skin-repository\/\.github\/guardrail: core's guardrail comes from there/
	);
});

// The working tree as a commit, through a scratch index, so a test covers the
// files as they stand rather than the last commit. No ref moves.
function workingTreeCommit(): string {
	const env = { ...process.env, ...IDENT, GIT_INDEX_FILE: join(tmp(), 'index') };
	const run = (...args: string[]) =>
		execFileSync('git', args, { cwd: ROOT, env, encoding: 'utf8' }).trim();
	run('read-tree', 'HEAD');
	run('add', '-A');
	return run('commit-tree', run('write-tree'), '-p', 'HEAD', '-m', 'e46 export test');
}

test(
	"E46 R3: this tree's core carries CODEOWNERS, MAINTAINERS and the skin repository's guardrail byte for byte",
	{ skip: notUnsplit },
	() => {
		const out = join(tmp(), 'split');
		const r = split(ROOT, [out, workingTreeCommit()]);
		assert.equal(r.status, 0, r.stderr);
		for (const path of ['.github/workflows/guardrail.yml', '.github/guardrail/guardrail.mjs']) {
			assert.equal(readFileSync(join(out, 'core', path), 'utf8'), read(`${STARTER}/${path}`), path);
		}
		for (const path of [
			'.github/CODEOWNERS',
			'MAINTAINERS',
			'.github/workflows/ci.yml',
			'scripts/upgrade-check.sh'
		]) {
			assert.equal(readFileSync(join(out, 'core', path), 'utf8'), read(path), path);
		}
	}
);

test('E46 R3: docs/skin-repository.md says core swaps the guardrail for branch protection at the flip to public', () => {
	const doc = read('docs/skin-repository.md');
	assert.match(
		doc,
		/\*\*Core swaps the guardrail for branch protection at the flip to public\.\*\*/
	);
	assert.match(
		doc,
		/`CI \/ check` and `CI \/ upgrade` checks, then delete the guardrail workflow and its script/
	);
	assert.match(
		read('docs/upgrading.md'),
		/The `upgrade` job in `\.github\/workflows\/ci\.yml` runs `scripts\/upgrade-check\.sh`/
	);
	assert.doesNotMatch(read('docs/upgrading.md'), /not in `\.github\/workflows\/ci\.yml` yet/);
});

// Follow-up #93: an exported core carries skin/default alone. Runs the real
// export, then the real skin test file inside the result.
test(
	'E46 #93: an exported core passes its skin tests with no community skin beside the default',
	{ skip: notUnsplit, timeout: 300_000 },
	() => {
		const gl = stubGitleaks(PINNED);
		const out = join(tmp(), 'split');
		const r = split(ROOT, ['--init', ...AUTHOR, out, workingTreeCommit()], pathWith(gl.bin));
		assert.equal(r.status, 0, r.stderr);
		const core = join(out, 'core');
		assert.deepEqual(readdirSync(join(core, 'skin')), ['default']);
		symlinkSync(join(ROOT, 'node_modules'), join(core, 'node_modules'));
		execFileSync(join(core, 'node_modules/.bin/svelte-kit'), ['sync'], {
			cwd: core,
			stdio: 'ignore'
		});
		const env: Record<string, string | undefined> = { ...process.env, SKIN_DIR: 'skin/default' };
		delete env.NODE_TEST_CONTEXT;
		const t = spawnSync(
			process.execPath,
			[
				'--import',
				'tsx',
				'--import',
				'./src/lib/skin/register-node.ts',
				'--experimental-test-module-mocks',
				'--test',
				'src/lib/skin/skin.test.ts'
			],
			{ cwd: core, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
		);
		const failed = t.stdout.match(/^not ok .*$/gm) ?? [];
		assert.equal(t.status, 0, failed.join('\n') || t.stderr);
		assert.match(t.stdout, /^# fail 0$/m);
		const skipped = Number(t.stdout.match(/^# skipped (\d+)$/m)?.[1]);
		assert.ok(skipped >= 19, `only ${skipped} community tests skipped`);
		assert.match(t.stdout, /# SKIP this tree ships no community skin beside skin\/default/);
	}
);

// ---------------------------------------------------------------------------
// 4: the release procedure
// ---------------------------------------------------------------------------

test('E46 R4: docs/releasing.md gives the tag form, never moves a tag, snapshots the default skin in the tagged commit, and moves a pin', () => {
	const doc = read('docs/releasing.md');
	assert.match(doc, /^# Releasing$/m);
	assert.match(doc, /A release is a tag named `v\{major\}\.\{minor\}\.\{patch\}`/);
	assert.match(doc, /\*\*A tag is never moved and never deleted once pushed\.\*\*/);
	assert.match(doc, /cp skin\/default\/skin\.yaml "src\/lib\/skin\/released\/\$tag\.yaml"/);
	assert.match(doc, /The copy and the tag go on the same commit\./);
	assert.match(
		doc,
		/git diff --exit-code "\$tag:skin\/default\/skin\.yaml" "\$tag:src\/lib\/skin\/released\/\$tag\.yaml"/
	);
	assert.match(doc, /## Moving a site's pin[\s\S]*git checkout v0\.2\.0[\s\S]*git add core/);
	assert.match(doc, /\[Upgrading\]\(upgrading\.md\) says what a version number promises/);
	assert.match(read('README.md'), /^- \[Releasing\]\(docs\/releasing\.md\): /m);
	assert.match(read('docs/skin-repository.md'), /\[Releasing\]\(releasing\.md\)/);
});

test(
	'E46 R4: the v0.1.0 snapshot is the default skin the one-commit export will carry and tag',
	{ skip: notUnsplit },
	() => {
		assert.equal(read('src/lib/skin/released/v0.1.0.yaml'), read('skin/default/skin.yaml'));
	}
);
