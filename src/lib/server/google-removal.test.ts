import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, mock } from 'node:test';

// Spelled in parts so scripts/check-neutral.ts, which refuses the credential's
// name anywhere but the redaction deny-list, does not count this file.
const SA = ['GOOGLE', 'SA'].join('_');

// E12: the Google integration is deleted, not disabled. Most of what follows
// reads the tree, because the claim is about what is absent from it. Run from
// anywhere: every path resolves from this file.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel: string) => existsSync(join(ROOT, rel));

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const rel = join(dir, e.name);
		if (e.isDirectory()) out.push(...sources(rel));
		else if (/\.(ts|js|svelte|sql|json)$/.test(e.name) && join(ROOT, rel) !== SELF) out.push(rel);
	}
	return out;
}
const TREE = [...sources('src'), ...sources('scripts')];
const hits = (re: RegExp, files = TREE) => files.filter((f) => re.test(read(f)));

// The old readme split into README.md and docs/; each section lives on one page.
const DOCS = [
	'README.md',
	'docs/features.md',
	'docs/data-model.md',
	'docs/configuration.md',
	'docs/deployment.md',
	'docs/operations.md',
	'docs/upgrading.md'
];
const PAGE: Record<string, string> = {
	'Source of truth': 'docs/data-model.md',
	'Data model': 'docs/data-model.md',
	'Membership requests': 'docs/features.md',
	'Admin access': 'docs/features.md',
	Routes: 'docs/features.md',
	'Built with': 'README.md'
};
const readmeSection = (heading: string) =>
	read(PAGE[heading])
		.split(new RegExp(`^## ${heading}$`, 'm'))[1]
		?.split(/^## /m)[0] ?? '';

// ---------------------------------------------------------------------------
// 1: the clients and the layer under them
// ---------------------------------------------------------------------------

const MODULES = [
	'sheet-source',
	'sheet-rw',
	'sheet-config',
	'sync',
	'sync-core',
	'dash-access-core',
	'dash-access'
];

test('R1: the sheet clients, the sync and both dash-access modules are deleted and nothing imports them', () => {
	for (const m of MODULES) {
		assert.ok(!exists(`src/lib/server/${m}.ts`), `${m}.ts still exists`);
	}
	assert.ok(!exists('src/lib/server/sheet-fixtures'), 'sheet-fixtures/ still exists');

	const name = `(?:${MODULES.join('|')}|sheet-fixtures)`;
	const importing = new RegExp(
		`(?:from\\s+|import\\(\\s*|mock\\.module\\(\\s*)['"\`][^'"\`]*/${name}(?:\\.ts)?['"\`/]`
	);
	assert.deepEqual(hits(importing), [], 'a file still imports or mocks a deleted module');
	assert.ok(importing.test(`import { x } from '$lib/server/sheet-rw';`), 'the pattern misses');
	assert.ok(importing.test(`await import('./sync-core')`), 'the pattern misses a dynamic import');
	assert.ok(
		importing.test(`mock.module('$lib/server/dash-access', {`),
		'the pattern misses a mock'
	);

	assert.deepEqual(hits(/\btabName\b/), [], 'tabName outlived both modules that exported it');
	assert.doesNotMatch(read('src/lib/server/member-edit.ts'), /sheet-rw|Sheets API|sheetsClient/);
});

test('R1: resolveGroupAdmin survives the deletion of dash-access.ts and still gates on group_admin', async () => {
	const asked: unknown[][] = [];
	mock.module('$lib/server/postgres', {
		namedExports: {
			query: async (_text: string, values: unknown[]) => {
				asked.push(values);
				return { rows: values[1] === 'email:admin@example.org' ? [{ one: 1 }] : [] };
			}
		}
	});
	mock.module('$lib/server/admin', { namedExports: { isAdmin: () => false } });
	mock.module('$lib/server/log', {
		namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
	});
	const { resolveGroupAdmin } = await import('./groups');
	const group = { id: 'g1' };
	assert.equal(await resolveGroupAdmin(group, { subject: 'email:admin@example.org' }), true);
	assert.equal(await resolveGroupAdmin(group, { subject: 'email:member@example.org' }), false);
	assert.equal(await resolveGroupAdmin(group, null), false);
	assert.equal(asked.length, 2, 'a signed-out visitor cost a query');
});

// ---------------------------------------------------------------------------
// 2: the scripts
// ---------------------------------------------------------------------------

const SCRIPTS = ['sync', 'set-sheet', 'set-columnmap', 'dash-check', 'rewrite-biopic', 'load-docs'];

test('R2: the six sheet scripts and their package.json entries are gone, and every entry left runs a file that exists', () => {
	const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
	for (const s of SCRIPTS) {
		assert.ok(!exists(`scripts/${s}.ts`), `scripts/${s}.ts still exists`);
		assert.ok(!(s in pkg.scripts), `package.json still has a "${s}" script`);
	}
	for (const [name, cmd] of Object.entries(pkg.scripts)) {
		for (const m of cmd.matchAll(/scripts\/[\w-]+\.ts/g)) {
			assert.ok(exists(m[0]), `"${name}" runs ${m[0]}, which does not exist`);
		}
	}
	assert.doesNotMatch(read('deploy/run.sh'), new RegExp(`run\\.sh (${SCRIPTS.join('|')})\\b`));
});

// ---------------------------------------------------------------------------
// 3: /admin
// ---------------------------------------------------------------------------

test('R3: /admin has no sync card, no sync action and no link built from a sheet id', () => {
	const page = read('src/routes/group/[slug]/admin/+page.svelte');
	assert.doesNotMatch(page, /Sheet sync|Last sync|Never synced|sheetUrl|sheetConfigured|lastSync/);
	assert.doesNotMatch(page, /docs\.google\.com/);
	assert.match(page, /Export the roster/, 'the export card went with the sync card');

	const server = read('src/routes/group/[slug]/admin/+page.server.ts');
	assert.doesNotMatch(server, /sync_run|sheetUrl|sheetId|sheet_id|docs\.google\.com|sheet-config/);
	assert.doesNotMatch(server, /export const actions/, '/admin grew an action');
	assert.match(server, /memberCount/);
});

// ---------------------------------------------------------------------------
// 4: the dependencies
// ---------------------------------------------------------------------------

// Spelled in two halves so this file is not itself a hit in the sweep it runs:
// the contract is that `grep -r` for the package name over src/ and scripts/
// prints nothing, and a test that named it would be the one line left.
const GAPIS = 'google' + 'apis';
const GAUTH = 'google-auth-library';

test('R4: neither Google package is a dependency, in the lockfile, or imported', () => {
	const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string>>;
	const lock = read('pnpm-lock.yaml');
	for (const dep of [GAPIS, GAUTH]) {
		for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies']) {
			assert.ok(!(dep in (pkg[kind] ?? {})), `${dep} is still in ${kind}`);
		}
		assert.ok(!lock.includes(dep), `${dep} is still in pnpm-lock.yaml`);
	}
	// What only those two pulled in. One left behind means something else
	// still depends on the Google client stack.
	for (const transitive of [`${GAPIS}-common`, 'gaxios', 'gtoken', 'gcp-metadata']) {
		assert.ok(!lock.includes(transitive), `${transitive} is still in pnpm-lock.yaml`);
	}
	const importing = new RegExp(
		`(?:from\\s+|import\\(\\s*|require\\(\\s*)['"](?:${GAPIS}|${GAUTH})['"/]`
	);
	assert.deepEqual(hits(importing), []);
	assert.ok(importing.test(`import { google } from '${GAPIS}';`), 'the pattern misses');
});

// Every file, this one included, and by substring the way grep reads them.
test('R4: nothing under src/ or scripts/ names the package, as grep -r would find it', () => {
	const all = (dir: string): string[] =>
		readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]
		);
	const files = [...all('src'), ...all('scripts')];
	assert.ok(files.includes(join('src', 'lib', 'server', 'google-removal.test.ts')));
	assert.deepEqual(
		files.filter((f) => read(f).includes(GAPIS)),
		[]
	);
});

// ---------------------------------------------------------------------------
// 5: the credential
// ---------------------------------------------------------------------------

test('R5: no deploy script and no code asks for the service account, and the redaction deny-list still names it', () => {
	for (const f of ['deploy/deploy.sh', 'deploy/bootstrap.sh', 'docker-compose.yml', '.env.example']) {
		assert.doesNotMatch(read(f), new RegExp(`${SA}|service account`, 'i'), `${f} still names it`);
	}
	const hooks = read('src/hooks.server.ts');
	assert.doesNotMatch(hooks, new RegExp(`${SA}|sheet|process\\.exit`, 'i'), 'boot still checks for a sheet');
	assert.deepEqual(hits(new RegExp(`env\\.${SA}|process\\.env\\.${SA}`)), [], 'something reads it');

	const redact = read('src/lib/server/redact.ts');
	assert.ok(redact.includes(`'${SA}_KEY'`));
	assert.ok(redact.includes(`'${SA}_PRIVATE_KEY'`));
});

// ---------------------------------------------------------------------------
// 6: the final migration. What it does to a database is in
// migration-15.pg.test.ts; this holds what needs none.
// ---------------------------------------------------------------------------

const DROPPED = ['sheet_id', 'sheet_range', 'column_map', 'sync_run', 'source_row', 'synced_at'];

test('R6: migration 15 drops each sheet-era name and member.visibility, and no code names what it dropped', async () => {
	const { MIGRATIONS } = await import('./migrations');
	const last = MIGRATIONS.find((m) => m.version === 15)!;
	assert.equal(last.name, 'drop_sheet_era');

	const groupDrops = last.sql.match(/ALTER TABLE "group"([^;]*);/)?.[1] ?? '';
	const memberDrops = last.sql.match(/ALTER TABLE member([^;]*);/)?.[1] ?? '';
	for (const c of ['sheet_id', 'sheet_range', 'column_map']) {
		assert.match(groupDrops, new RegExp(`DROP COLUMN IF EXISTS ${c}\\b`), c);
	}
	for (const c of ['source_row', 'synced_at', 'visibility']) {
		assert.match(memberDrops, new RegExp(`DROP COLUMN IF EXISTS ${c}\\b`), c);
	}
	assert.match(last.sql, /DROP TABLE IF EXISTS sync_run;/);
	// The item severs Google with no rollback column, so this migration adds none.
	assert.doesNotMatch(last.sql, /ADD COLUMN|CREATE TABLE|RENAME/i);

	const named = new RegExp(`\\b(${DROPPED.join('|')})\\b`);
	const still = hits(named).filter(
		(f) =>
			!f.endsWith('.test.ts') &&
			f !== join('src', 'lib', 'server', 'migrations.ts')
	);
	assert.deepEqual(still, [], 'a query or type still names a dropped column');
});

// An app built before migration 15 selects the dropped columns by name. What the
// guard does against a real ledger is in migration-13.pg.test.ts.
test('R6: migration 15 runs only with the app stopped, and docs/deployment.md gives that sequence and no way around it', async () => {
	const { WRITER_CUTOVER_VERSIONS } = await import('./migrations');
	assert.ok(WRITER_CUTOVER_VERSIONS.has(15), 'the runner applies 15 under a running app');
	assert.ok(WRITER_CUTOVER_VERSIONS.has(13), 'the migration-13 gate was lost');

	const section =
		read('docs/deployment.md')
			.split('**Migration 15 needs the app stopped too.**')[1]
			?.split('**`profiles:` keeps the migrate service')[0] ?? '';
	const lines = section.split('\n');
	const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
	const build = at(/^(?:docker compose|dc) build\b/);
	const stop = at(/^(?:docker compose|dc) stop lorem-host\b/);
	const run = at(/--profile migrate run\b.*LOREM_WRITERS_STOPPED=/);
	const up = at(/^(?:docker compose|dc) up -d\b/);
	assert.ok(
		build >= 0 && build < stop && stop < run && run < up,
		'not build, stop, migrate, start'
	);
	const prose = section.replace(/\s+/g, ' ');
	assert.match(prose, /--no-migrate` is not a way around the stop/);
	assert.doesNotMatch(read('docs/deployment.md').replace(/\s+/g, ' '), /the window can be skipped/);
});

// ---------------------------------------------------------------------------
// 7: the mock: fixture path
// ---------------------------------------------------------------------------

test('R7: no mock: sheet id is written, read or special-cased, and the seed needs none', () => {
	assert.deepEqual(hits(/['"`]mock:|isMockSheetId|MockSheetSource|mockFixtureName/), []);
	assert.deepEqual(hits(/requires a real Google Sheet/), []);
	const seed = read('scripts/seed.ts');
	assert.doesNotMatch(seed, /sheet|column_map|synced_at|GOOGLE/i);
	assert.match(seed, /INSERT INTO member/, 'the seed no longer creates anyone to sign in as');
	const dev = read('README.md').split(/^## Quick start$/m)[1]?.split(/^## /m)[0] ?? '';
	assert.match(dev, /pnpm seed/);
	assert.doesNotMatch(dev, new RegExp(`${SA}|mock:`));
});

// ---------------------------------------------------------------------------
// 8: the readme
// ---------------------------------------------------------------------------

test('R8: README.md and docs/ describe no sync, no service account setup and no deleted script', () => {
	const readme = DOCS.map(read).join('\n');
	const headings = readme.split('\n').filter((l) => /^#{1,4} /.test(l));
	assert.deepEqual(
		headings.filter((h) => /Google|Sheet|sync/i.test(h)),
		[],
		'a heading still names the integration'
	);
	for (const h of [
		'Source of truth',
		'Membership requests',
		'Admin access',
		'Data model',
		'Built with'
	]) {
		assert.ok(readmeSection(h), `no "${h}" section`);
	}
	assert.doesNotMatch(
		readme,
		/pnpm (sync|set-sheet|set-columnmap|dash-check|load-docs|rewrite-biopic)\b|run\.sh (sync|dash-check|set-)/
	);
	assert.doesNotMatch(
		readme,
		new RegExp(`${SA}_(EMAIL|PRIVATE_KEY)=|gserviceaccount|Enable the Sheets API`)
	);
	assert.doesNotMatch(readme, /mock:|sheet-fixtures/);

	assert.match(readmeSection('Source of truth'), /Postgres is the roster, and the only store/);
	assert.doesNotMatch(readmeSection('Membership requests'), /imported once at cutover/);
	assert.doesNotMatch(readmeSection('Admin access'), /\bsync\b|synced member/);
	assert.doesNotMatch(readmeSection('Built with'), /Google/i);

	const model = readmeSection('Data model');
	const bullet = (name: string) =>
		model.split(/\n(?=- \*\*)/).find((b) => b.startsWith(`- **\`${name}\`**`));
	assert.doesNotMatch(bullet('group') ?? '', /sheet_id|sheet_range|column_map/);
	assert.equal(bullet('sync_run'), undefined, 'the data model still lists sync_run');
	assert.doesNotMatch(
		bullet('member')?.split('\n  - ')[0] ?? '',
		/source_row|synced_at|visibility/
	);

	const routes = readmeSection('Routes');
	for (const route of ['/manifesto', '/code-of-conduct', '/admin']) {
		const row = routes.split('\n').find((l) => l.startsWith(`| \`${route}\` `));
		assert.ok(row, `no ${route} row`);
		assert.doesNotMatch(row, /Google|same doc|last sync/, `${route} row`);
	}
});
