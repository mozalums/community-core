import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
	cpSync,
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
import { register } from 'node:module';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import {
	CODE_EXTENSIONS,
	DEFAULT_SKIN_DIR,
	assertSkinAtBoot,
	loadReleasedSkins,
	loadSkinDir,
	skinDir,
	skinModuleSource,
	skinPlugin
} from './load';
import {
	FIELD_ROLES,
	SCHEMA_VERSIONS,
	SkinError,
	describeSkinSchema,
	parseSkin,
	validateSkin,
	type Skin
} from './schema';
import { CONTRAST_FLOOR, PAGE_BACKGROUNDS, contrastRatio, readTheme } from './theme';
import { stageSkinAssets } from './assets.js';
import * as fieldSchema from '../server/field-schema';
import { DEFAULT_FIELD_SCHEMA } from '../server/field-schema';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '../server/field-schema-fake';
import { COPY_NAMES, skinCopy } from '../server/skin-copy';

const ROOT = new URL('../../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DEFAULT = join(ROOT, 'skin/default');
// The shipped skin besides the default, found rather than named so platform
// source carries no community's name.
const COMMUNITY_ID = readdirSync(join(ROOT, 'skin'))
	.filter((d) => d !== 'default')
	.sort()[0];
const COMMUNITY_REL = `skin/${COMMUNITY_ID}`;
const COMMUNITY = join(ROOT, COMMUNITY_REL);
// An exported core ships skin/default alone. A test about the community skin
// skips there and runs in the skin repository's CI, which stages its skin
// beside the default; a test over every shipped skin covers the default alone.
const noCommunity =
	COMMUNITY_ID === undefined && 'this tree ships no community skin beside skin/default';
const SHIPPED = noCommunity ? [DEFAULT] : [DEFAULT, COMMUNITY];

function sources(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
		const p = `${dir}/${e.name}`;
		if (e.isDirectory()) return sources(p);
		return /\.(ts|js|svelte|html)$/.test(e.name) ? [p] : [];
	});
}

// A copy of the default skin a test may break.
function scratch(t: TestContext, edit?: (yaml: string) => string): string {
	const dir = mkdtempSync(join(tmpdir(), 'skin-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cpSync(DEFAULT, dir, { recursive: true });
	if (edit)
		writeFileSync(join(dir, 'skin.yaml'), edit(readFileSync(join(dir, 'skin.yaml'), 'utf8')));
	return dir;
}

function refusal(fn: () => unknown): SkinError {
	try {
		fn();
	} catch (e) {
		assert.ok(e instanceof SkinError, `threw ${String(e)}, not a SkinError`);
		return e;
	}
	assert.fail('the skin was accepted');
}

const defaultYaml = () => read('skin/default/skin.yaml');

// ---------------------------------------------------------------------------
// 1: dead code is not carried into core
// ---------------------------------------------------------------------------

test('R1: the dead modules, the off-site sitemap line and the inamoon meta are gone, and nothing imports them', () => {
	for (const gone of [
		'src/lib/blog.ts',
		'src/lib/components/FancyButton.svelte',
		'src/lib/components/PublicMenu.svelte'
	]) {
		assert.ok(!existsSync(join(ROOT, gone)), `${gone} still exists`);
	}
	const self = 'src/lib/skin/skin.test.ts';
	const importers = [...sources('src'), ...sources('scripts')].filter(
		(p) => p !== self && /lib\/blog['"]|FancyButton|PublicMenu/.test(read(p))
	);
	assert.deepEqual(importers, [], 'a file still names a deleted module');
	assert.doesNotMatch(read('static/robots.txt'), /^Sitemap:/m, 'robots.txt names a sitemap');
	assert.doesNotMatch(read('src/app.html'), /inamoon/);
});

// ---------------------------------------------------------------------------
// 2: the format, one schema module, a pinned parser, a version
// ---------------------------------------------------------------------------

test('R2: both shipped skins are the four-entry directory and load; the default is Example Community on example.org', () => {
	for (const dir of SHIPPED) {
		// A community keeps its site's runbook, deploy files and maintainer list
		// beside its skin; the loader reads none of them, and core's own skin has none.
		const site = dir === COMMUNITY ? ['MAINTAINERS', 'RUNBOOK.md', 'deploy'] : [];
		assert.deepEqual(
			readdirSync(dir)
				.filter((e) => !site.includes(e))
				.sort(),
			['copy', 'skin.yaml', 'static', 'theme.css'],
			`${dir} is not a skin directory`
		);
		assert.equal(loadSkinDir(dir).skin.schema, 1);
	}
	const { skin } = loadSkinDir(DEFAULT);
	assert.equal(skin.id, 'default');
	assert.equal(skin.site.legal_name, 'Example Community');
	assert.equal(skin.site.domain, 'example.org');
	if (!noCommunity) {
		const community = loadSkinDir(COMMUNITY).skin;
		assert.equal(community.id, COMMUNITY_ID);
		assert.notEqual(community.site.domain, skin.site.domain);
	}
	assert.match(defaultYaml(), /^schema: 1$/m);
	assert.ok(
		/^schema: 1$/.test(
			defaultYaml()
				.split('\n')
				.filter((l) => l && !l.startsWith('#'))[0]
		)
	);
});

test('R2: a skin directory missing one of its four entries is refused by name', (t) => {
	for (const entry of ['copy', 'theme.css', 'static', 'skin.yaml']) {
		const dir = scratch(t);
		rmSync(join(dir, entry), { recursive: true });
		const e = refusal(() => loadSkinDir(dir));
		assert.ok(
			e.issues.some((i) => i.path === entry && i.found === 'nothing'),
			`${entry}: ${e.message}`
		);
	}
});

test('R2: an unknown key, a missing required key and a wrong type are each an error naming the path', () => {
	const typo = refusal(() =>
		parseSkin(defaultYaml().replace('legal_name:', 'legl_name:'), 'skin.yaml')
	);
	assert.deepEqual(
		typo.issues.map((i) => [i.path, i.found]),
		[
			['site.legl_name', 'an unknown key'],
			['site.legal_name', 'nothing']
		],
		'a misspelled key read as unset'
	);
	assert.match(
		typo.message,
		/site\.legl_name: found an unknown key, expected one of domain, legal_name/
	);

	const wrong = refusal(() =>
		parseSkin(defaultYaml().replace('domain: example.org', 'domain: 42'), 'skin.yaml')
	);
	assert.deepEqual(wrong.issues, [
		{ path: 'site.domain', found: 'the number 42', expected: 'a bare domain name' }
	]);

	const nested = refusal(() =>
		parseSkin(defaultYaml().replace('visibility: private', 'visibility: hidden'), 'skin.yaml')
	);
	assert.equal(nested.issues[0].path, 'fields[4].visibility');
	assert.equal(nested.issues[0].expected, 'one of members, private');

	const top = refusal(() => parseSkin(`${defaultYaml()}\ntheme: dark\n`, 'skin.yaml'));
	assert.equal(top.issues[0].path, 'theme');

	// The same key twice is how a typo'd override hides: the parser refuses it.
	const twice = refusal(() => parseSkin(`${defaultYaml()}\nid: other\n`, 'skin.yaml'));
	assert.match(twice.message, /invalid YAML/);
});

test('R2: the Skin type and the validator come from the one definition in schema.ts', { skip: noCommunity }, () => {
	const skin: Skin = loadSkinDir(DEFAULT).skin;
	const legal: string = skin.site.legal_name;
	assert.equal(legal, 'Example Community');
	// @ts-expect-error the type has only the keys the schema declares
	assert.equal(skin.site.legl_name, undefined);
	// @ts-expect-error an enum value the schema does not list is not in the type
	const bad: Skin['fields'][number]['visibility'] = 'hidden';
	assert.ok(bad);

	// Every key the validator accepts is one the schema describes, and the
	// reverse: a key cannot be in one and not the other.
	const paths = describeSkinSchema().map((r) => r.path);
	const seen = new Set<string>();
	const walk = (v: unknown, at: string): void => {
		if (Array.isArray(v)) return v.forEach((item) => walk(item, `${at}[]`));
		if (typeof v !== 'object' || v === null) return;
		for (const [k, child] of Object.entries(v)) {
			seen.add(at ? `${at}.${k}` : k);
			walk(child, at ? `${at}.${k}` : k);
		}
	};
	walk(skin, '');
	walk(loadSkinDir(COMMUNITY).skin, '');
	assert.deepEqual([...seen].sort(), [...paths].sort());

	const definers = sources('src').filter(
		(p) => !p.endsWith('.test.ts') && /legal_name\s*:/.test(read(p))
	);
	assert.deepEqual(definers, ['src/lib/skin/schema.ts'], 'a second module declares skin keys');
});

test('R2: YAML is parsed by the yaml package pinned in pnpm-lock.yaml, and by nothing hand-written', () => {
	const version = JSON.parse(read('package.json')).dependencies.yaml;
	assert.match(version, /^\d+\.\d+\.\d+$/, 'yaml is not pinned to one version');
	assert.match(
		read('pnpm-lock.yaml'),
		new RegExp(`\\n  yaml@${version}:\\n    resolution: \\{integrity: sha512-`)
	);
	assert.match(read('src/lib/skin/schema.ts'), /import \{ parse \} from 'yaml';/);
	for (const p of ['src/lib/skin/schema.ts', 'src/lib/skin/load.ts']) {
		assert.doesNotMatch(read(p), /\.split\(\s*['"`]\\n|indexOf\(':'\)/, `${p} splits YAML by hand`);
	}
});

test('R2: an unknown schema version is refused, naming the version found, the versions read and which way to move', () => {
	const newer = refusal(() => parseSkin(defaultYaml().replace('schema: 1', 'schema: 2'), 's.yaml'));
	assert.equal(newer.issues.length, 1, 'key errors buried the version error');
	assert.match(newer.message, /s\.yaml: schema: found the number 2, expected .*\(1\)/);
	assert.match(newer.message, /newer than this core: pin a newer core release/);

	const older = refusal(() => parseSkin(defaultYaml().replace('schema: 1', 'schema: 0'), 's.yaml'));
	assert.match(older.message, /found the number 0/);
	assert.match(older.message, /older than this core/);

	const absent = refusal(() => parseSkin(defaultYaml().replace('schema: 1\n', ''), 's.yaml'));
	assert.deepEqual(
		absent.issues.map((i) => i.path),
		['schema']
	);
	assert.deepEqual(SCHEMA_VERSIONS, [1]);
});

// ---------------------------------------------------------------------------
// 3: validated at build and at boot; a skin holds no code
// ---------------------------------------------------------------------------

test('R3: the build runs the loader, so a bad skin fails it', (t) => {
	const dir = scratch(t, (y) => y.replace('legal_name:', 'legl_name:'));
	const bad = skinPlugin(dir);
	assert.equal(typeof bad.buildStart, 'function');
	const e = refusal(() => (bad.buildStart as () => void)());
	assert.match(e.message, /site\.legl_name/);

	const good = skinPlugin(DEFAULT);
	(good.buildStart as () => void)();
	assert.match(read('vite.config.ts'), /plugins: \[skinPlugin\(\), sveltekit\(\)\]/);
});

test('R3: boot refuses an invalid skin, a missing one, and one that differs from the build', (t) => {
	const built = defaultYaml();
	assert.equal(assertSkinAtBoot(built, DEFAULT).skin.id, 'default');

	const invalid = scratch(t, (y) => y.replace('schema: 1', 'schema: 7'));
	assert.match(refusal(() => assertSkinAtBoot(built, invalid)).message, /found the number 7/);

	const missing = refusal(() => assertSkinAtBoot(built, join(tmpdir(), 'no-such-skin')));
	assert.match(
		missing.message,
		/no-such-skin: found missing at SKIN_DIR, expected a skin directory/
	);

	const drifted = scratch(t, (y) => y.replace('Example Community', 'Another Community'));
	assert.match(
		refusal(() => assertSkinAtBoot(built, drifted)).message,
		/differs from the one this build was compiled with/
	);
});

test('R3: hooks.server runs the boot check before ensureSchema and lets its error stop the process', () => {
	const src = read('src/hooks.server.ts');
	assert.match(src, /import builtSkin from '\$skin\/skin\.yaml\?raw';/);
	const check = src.indexOf('assertSkinAtBoot(builtSkin);');
	const schema = src.indexOf('void ensureSchema();');
	assert.ok(check > 0 && check < schema, 'the boot check is not beside ensureSchema');
	const block = src.slice(check, schema);
	assert.match(block, /catch \(e\) \{\s*log\.error\('boot\.skin-refused'[^\n]*\n\s*throw e;/);
});

test('R3: the message names the file, the key, what was found and what was expected', (t) => {
	const dir = scratch(t, (y) => y.replace('label: Phone', 'label: [Phone]'));
	const e = refusal(() => loadSkinDir(dir));
	assert.equal(
		e.message,
		`${join(dir, 'skin.yaml')}: fields[4].label: found a list, expected a string`
	);
	assert.equal(e.file, join(dir, 'skin.yaml'));
});

test('R3: a skin directory holding a code file or a link is refused by name', (t) => {
	for (const ext of ['.svelte', '.ts', '.js', '.mjs', '.cjs']) {
		assert.ok(CODE_EXTENSIONS.includes(ext), `${ext} is not refused`);
	}
	for (const ext of CODE_EXTENSIONS) {
		const dir = scratch(t);
		writeFileSync(join(dir, 'static', `Widget${ext.toUpperCase()}`), '');
		const e = refusal(() => loadSkinDir(dir));
		assert.match(e.message, new RegExp(`static/Widget\\${ext.toUpperCase()}: found a code file`));
	}
	const linked = scratch(t);
	symlinkSync(join(ROOT, 'src/hooks.server.ts'), join(linked, 'copy', 'notes.md'));
	assert.match(
		refusal(() => loadSkinDir(linked)).message,
		/copy\/notes\.md: found a symbolic link/
	);
});

// ---------------------------------------------------------------------------
// 4: one switch
// ---------------------------------------------------------------------------

test('R4: SKIN_DIR selects the skin for the alias and the server, and both default to skin/default', { skip: noCommunity }, async (t) => {
	const before = process.env.SKIN_DIR;
	t.after(() => {
		if (before === undefined) delete process.env.SKIN_DIR;
		else process.env.SKIN_DIR = before;
	});
	const alias = async (tag: string) =>
		(await import(`../../../svelte.config.js?${tag}`)).default.kit.alias.$skin;

	process.env.SKIN_DIR = COMMUNITY_REL;
	assert.equal(await alias('set'), COMMUNITY_REL);
	assert.equal(skinDir(), COMMUNITY_REL);

	delete process.env.SKIN_DIR;
	assert.equal(await alias('unset'), DEFAULT_SKIN_DIR);
	assert.equal(skinDir(), DEFAULT_SKIN_DIR);
	assert.equal(DEFAULT_SKIN_DIR, 'skin/default');
});

test('E44 R2: the Dockerfile copies the skin from a context named skin, and compose passes it to every build from SKIN_DIR', () => {
	const dockerfile = read('Dockerfile');
	const stages = dockerfile.split(/^FROM /m);
	const skinStage = stages.find((stage) => /^scratch AS skin$/m.test(stage));
	assert.ok(skinStage, 'no default stage named skin');
	assert.match(skinStage, /^COPY skin\/default\/ \/$/m, 'the default stage is not the default skin');
	const build = stages.find((stage) => / AS build$/m.test(stage)) ?? '';
	const final = stages.at(-1) ?? '';
	assert.doesNotMatch(dockerfile, /^ARG SKIN_DIR/m, 'SKIN_DIR is still a build argument');
	for (const entry of ['/skin.yaml /theme.css skin/', '/copy/ skin/copy/', '/static/ skin/static/']) {
		const line = `COPY --from=skin ${entry}`;
		assert.ok(build.includes(line), `the build stage lacks ${line}`);
		assert.ok(build.indexOf(line) < build.indexOf('RUN pnpm run build'), `${line} comes after the build`);
	}
	for (const stage of [build, final]) assert.match(stage, /^ENV SKIN_DIR=skin$/m);
	assert.match(final, /^COPY --from=build \/app\/skin\/ skin\/$/m);
	assert.match(final, /^ARG LOREM_BUILD_SHA=unknown$/m);
	assert.match(final, /^ARG CORE_TAG=\nENV CORE_TAG=\$\{CORE_TAG\}$/m);

	const compose = read('docker-compose.yml');
	const services = compose.split(/^ {2}(?=[a-z-]+:$)/m);
	const built = services.filter((svc) => /^ {4}build:$/m.test(svc));
	assert.deepEqual(
		built.map((svc) => svc.split(':')[0]),
		['lorem-host', 'migrate', 'prune']
	);
	for (const svc of built) {
		const name = svc.split(':')[0];
		assert.match(svc, /^ {6}additional_contexts:\n {8}skin: \$\{SKIN_DIR:-skin\/default\}$/m, `${name} gets no skin context`);
		assert.doesNotMatch(svc, /^ {8}SKIN_DIR:/m, `${name} still passes SKIN_DIR as a build argument`);
		// The secrets file may carry the host's SKIN_DIR for the build; env_file
		// would hand that path to a container where it names nothing.
		assert.match(svc, /^ {6}SKIN_DIR: skin$/m, `${name} does not pin the in-image skin path`);
	}
	assert.match(read('.dockerignore'), /^!skin\/\*\*\/\*\.md$/m);
});

test('R4: the line that reports the build SHA names the skin, read from the compiled-in skin', { skip: noCommunity }, () => {
	const landing = read('src/lib/components/Landing.svelte');
	const sidebar = read('src/lib/components/Sidebar.svelte');
	for (const src of [landing, sidebar]) {
		assert.match(src, /import \{ id as skinId \} from '\$skin\/skin\.yaml';/);
	}
	assert.match(landing, /^\s*build \{buildSha\}\{coreTag \? ` · core \$\{coreTag\}` : ''\} · skin \{skinId\}$/m);
	assert.match(sidebar, /`build \$\{buildSha\}\$\{coreTag \? ` · core \$\{coreTag\}` : ''\} · skin \$\{skinId\}`/);
	assert.match(
		skinModuleSource(loadSkinDir(COMMUNITY)),
		new RegExp(`^export const id = "${COMMUNITY_ID}";$`, 'm')
	);
});

// ---------------------------------------------------------------------------
// 5: site.ts reads the skin
// ---------------------------------------------------------------------------

test('R5: site.ts takes the legal name and the fallback domain from the skin, and LEGAL_UPDATED_AT is gone', { skip: noCommunity }, async (t) => {
	const src = read('src/lib/site.ts');
	const { site } = loadSkinDir(COMMUNITY).skin;
	for (const literal of [site.legal_name, site.domain]) {
		for (const q of ['"', "'", '`']) {
			assert.ok(!src.includes(`${q}${literal}${q}`), `an identity literal: ${literal}`);
		}
	}
	const named = sources('src').filter((p) => /LEGAL_UPDATED_AT/.test(read(p)));
	assert.deepEqual(named, ['src/lib/skin/skin.test.ts']);
	const identity = sources('src/lib').filter(
		(p) =>
			!p.endsWith('.test.ts') && /export const COMPANY_|export const APP_APEX_DOMAIN/.test(read(p))
	);
	assert.deepEqual(identity, ['src/lib/site.ts'], 'a second identity module');

	// The module the Vite plugin serves for `$skin/skin.yaml`, per skin.
	const load = async (dir: string, tag: string) => {
		const stubs = {
			'$env/dynamic/public': 'export const env = globalThis.__publicEnv;',
			'$skin/skin.yaml': skinModuleSource(loadSkinDir(dir))
		};
		register(
			'data:text/javascript,' +
				encodeURIComponent(`
  const stubs = ${JSON.stringify(stubs)};
  export async function resolve(specifier, context, next) {
    if (specifier in stubs && context.parentURL?.includes(${JSON.stringify(`site.ts?${tag}`)})) return {
      url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]) + '#${tag}',
      shortCircuit: true
    };
    return next(specifier, context);
  }
`),
			import.meta.url
		);
		return import(`../site.ts?${tag}`);
	};
	const g = globalThis as { __publicEnv?: Record<string, string> };
	t.after(() => delete g.__publicEnv);

	g.__publicEnv = {};
	const plain = await load(DEFAULT, 'default');
	assert.equal(plain.COMPANY_LEGAL_NAME, 'Example Community');
	assert.equal(plain.APP_APEX_DOMAIN, 'example.org');
	assert.equal(plain.APP_BASE_URL, 'https://www.example.org');

	const community = loadSkinDir(COMMUNITY).skin.site;
	const other = await load(COMMUNITY, COMMUNITY_ID);
	assert.equal(other.COMPANY_LEGAL_NAME, community.legal_name);
	assert.equal(other.APP_APEX_DOMAIN, community.domain);

	g.__publicEnv = { PUBLIC_BASE_DOMAIN: 'chess.example' };
	const overridden = await load(DEFAULT, 'env');
	assert.equal(overridden.APP_APEX_DOMAIN, 'chess.example', 'the skin outranked the environment');
});

// ---------------------------------------------------------------------------
// 6: the field schema lives in skin.yaml
// ---------------------------------------------------------------------------

test('R6: the field schema is the running skin’s fields key, and platform code declares no field', () => {
	const { skin } = loadSkinDir(DEFAULT);
	assert.deepEqual(
		DEFAULT_FIELD_SCHEMA,
		skin.fields.map((f, i) => ({ ...f, order: (i + 1) * 10 }))
	);
	assert.ok(Object.isFrozen(DEFAULT_FIELD_SCHEMA));
	const src = read('src/lib/server/field-schema.ts');
	assert.match(src, /currentSkin\(\)\.skin\.fields/);
	assert.doesNotMatch(src, /\bkey: '|label: '/, 'field-schema.ts still declares a field');
});

test('R6: the default skin carries the small generic set and the community skin the full one', { skip: noCommunity }, () => {
	const fields = (dir: string) => loadSkinDir(dir).skin.fields;
	assert.deepEqual(
		fields(DEFAULT).map((f) => [f.key, f.visibility]),
		[
			['name', 'members'],
			['country', 'members'],
			['city', 'members'],
			['bio', 'members'],
			['phone', 'private']
		]
	);
	const moz = fields(COMMUNITY);
	assert.equal(moz.length, 31);
	assert.equal(moz.filter((f) => f.role === 'affiliation').length, 6);
	for (const role of ['handle', 'tenureStart', 'tenureEnd', 'publicProfile', 'avatar'] as const) {
		assert.equal(moz.filter((f) => f.role === role).length, 1, role);
	}
});

const FIELD = (key: string, extra = '') =>
	`  - { key: ${key}, label: ${key}, type: text, visibility: members${extra} }\n`;
const withFields = (...fields: string[]) =>
	defaultYaml().replace(/\nfields:[\s\S]*/, `\nfields:\n${fields.join('')}`);

test('R6: a member is named by one name field or by a given and a family name, and never both or half', () => {
	const NAME = FIELD('name', ', role: name, column: name');
	const GIVEN = FIELD('given', ', role: givenName, column: name');
	const FAMILY = FIELD('family', ', role: familyName, column: name');
	assert.ok(parseSkin(withFields(NAME), 'skin.yaml'));
	assert.ok(parseSkin(withFields(GIVEN, FAMILY), 'skin.yaml'));

	const expected = 'one field with role name, or one each with roles givenName and familyName';
	for (const [fields, found] of [
		[[FIELD('city')], 'no field with a name role'],
		[[GIVEN], 'the name roles givenName'],
		[[FAMILY], 'the name roles familyName'],
		[[NAME, GIVEN, FAMILY], 'the name roles name, givenName, familyName'],
		[[NAME, FAMILY], 'the name roles name, familyName']
	] as const) {
		assert.deepEqual(
			refusal(() => parseSkin(withFields(...fields), 'skin.yaml')).issues,
			[{ path: 'fields', found, expected }],
			found
		);
	}

	// A name field outside the name column would be stored and never shown.
	const stray = refusal(() =>
		parseSkin(withFields(FIELD('name', ', role: name, column: city')), 'skin.yaml')
	);
	assert.deepEqual(stray.issues, [
		{
			path: 'fields[0].column',
			found: 'the string "city"',
			expected: "name (a field with role name feeds the member's name)"
		}
	]);
	const unset = refusal(() => parseSkin(withFields(FIELD('name', ', role: name')), 'skin.yaml'));
	assert.equal(unset.issues[0].found, 'nothing');
});

test('R6: the email role is optional, and without it no field may take the export’s Email heading', () => {
	const NAME = FIELD('name', ', role: name, column: name');
	assert.equal(
		loadSkinDir(DEFAULT).skin.fields.some((f) => f.role === 'email'),
		false,
		'the default skin keeps the address as a profile field'
	);
	const e = refusal(() =>
		parseSkin(
			withFields(NAME, '  - { key: contact, label: email, type: text, visibility: members }\n'),
			'skin.yaml'
		)
	);
	assert.equal(e.issues[0].path, 'fields[1].label');
	assert.ok(
		parseSkin(
			withFields(
				NAME,
				'  - { key: contact, label: Email, type: email, visibility: private, role: email }\n'
			),
			'skin.yaml'
		)
	);
});

test('R6: a single-field role is held once, and no key or label twice', () => {
	const twoBios = refusal(() =>
		parseSkin(defaultYaml().replace('label: Phone\n', 'label: Phone\n    role: bio\n'), 'skin.yaml')
	);
	assert.equal(twoBios.issues[0].path, 'fields[4].role');
	const sameLabel = refusal(() =>
		parseSkin(defaultYaml().replace('label: Phone', 'label: Bio'), 'skin.yaml')
	);
	assert.equal(sameLabel.issues[0].path, 'fields[4].label');
});

test('R6: a key spelled like a fixed form control is refused where another field holds that control’s role', () => {
	const extra = (lines: string) => `${defaultYaml().trimEnd()}\n${lines}`;
	const held =
		'  - { key: showOnHome, label: Public profile, type: checkbox, visibility: members, role: publicProfile }\n';
	// The control's own field may be keyed anything, the control's name included.
	assert.ok(parseSkin(extra(held), 'skin.yaml'));
	assert.ok(parseSkin(extra(held.replace('showOnHome', 'publicProfile')), 'skin.yaml'));
	// With no field in the role there is no fixed control to collide with.
	const squatter =
		'  - { key: publicProfile, label: Public page, type: url, visibility: members }\n';
	assert.ok(parseSkin(extra(squatter), 'skin.yaml'));
	const both = refusal(() => parseSkin(extra(held + squatter), 'skin.yaml'));
	assert.deepEqual(both.issues, [
		{
			path: 'fields[6].key',
			found: '"publicProfile" on a field without role publicProfile (held by fields[5])',
			expected: 'another key (the profile form posts the publicProfile field as "publicProfile")'
		}
	]);
	const other = refusal(() =>
		parseSkin(
			extra(
				'  - { key: otherAffiliations, label: Notes, type: text, visibility: members }\n' +
					'  - { key: otherGroups, label: Other, type: text, visibility: members, role: affiliationOther }\n'
			),
			'skin.yaml'
		)
	);
	assert.equal(other.issues[0].path, 'fields[5].key');
	// No key can spell an affiliation box's control.
	assert.equal(
		refusal(() => parseSkin(defaultYaml().replace('key: phone', 'key: aff_phone'), 'skin.yaml'))
			.issues[0].path,
		'fields[4].key'
	);
});

test('R6: an option list or required on a field whose control cannot honor it is refused by path', () => {
	const ok = withFields(
		FIELD('name', ', role: name, column: name, required: true'),
		FIELD('homeland', ', options: countries'),
		FIELD('place', ', options: cities, required: false'),
		`  - { key: joined, label: joined, type: year, visibility: private, options: years }\n`
	);
	const fields = parseSkin(ok, 'ok.yaml').fields;
	assert.deepEqual(
		fields.map((f) => [f.key, f.options, f.required]),
		[
			['name', undefined, true],
			['homeland', 'countries', undefined],
			['place', 'cities', false],
			['joined', 'years', undefined]
		]
	);
	const NAME = FIELD('name', ', role: name, column: name');
	const refused = (yaml: string, path: string, found: RegExp) => {
		const e = refusal(() => parseSkin(yaml, 'bad.yaml'));
		const issue = e.issues.find((i) => i.path === path);
		assert.ok(issue, `${path} not among ${e.issues.map((i) => i.path).join(', ')}`);
		assert.match(issue.found, found);
	};
	// A value of the wrong type is an error, never "unset".
	refused(
		withFields(NAME, FIELD('a', ', required: "yes"')),
		'fields[1].required',
		/the string "yes"/
	);
	refused(withFields(NAME, FIELD('a', ', options: colours')), 'fields[1].options', /colours/);
	refused(withFields(NAME, FIELD('a', ', requird: true')), 'fields[1].requird', /unknown key/);
	const typed = (type: string, extra: string) =>
		`  - { key: a, label: a, type: ${type}, visibility: members${extra} }\n`;
	refused(
		withFields(NAME, typed('checkbox', ', required: true')),
		'fields[1].required',
		/checkbox/
	);
	refused(withFields(NAME, typed('checkbox', ', options: sizes')), 'fields[1].options', /checkbox/);
	refused(withFields(NAME, typed('longtext', ', options: sizes')), 'fields[1].options', /longtext/);
	refused(withFields(NAME, typed('list', ', options: sizes')), 'fields[1].options', /list/);
	refused(withFields(NAME, FIELD('a', ', role: bio, options: sizes')), 'fields[1].options', /bio/);
	for (const role of ['retired', 'avatar', 'affiliationOther']) {
		refused(
			withFields(NAME, FIELD('a', `, role: ${role}, required: true`)),
			'fields[1].required',
			new RegExp(role)
		);
		refused(
			withFields(NAME, FIELD('a', `, role: ${role}, options: sizes`)),
			'fields[1].options',
			new RegExp(role)
		);
	}
	// One country select feeds one city select.
	refused(
		withFields(NAME, FIELD('a', ', options: cities')),
		'fields[1].options',
		/no field offering countries/
	);
	refused(
		withFields(NAME, FIELD('a', ', options: countries'), FIELD('b', ', options: countries')),
		'fields[2].options',
		/second "countries"/
	);
	refused(
		withFields(
			NAME,
			FIELD('a', ', options: countries'),
			FIELD('b', ', options: cities'),
			FIELD('c', ', options: cities')
		),
		'fields[3].options',
		/second "cities"/
	);
});

test('R6: both shipped skins declare the controls their editor had, and the default phone stays optional', { skip: noCommunity }, () => {
	const controls = (dir: string) =>
		Object.fromEntries(
			loadSkinDir(dir)
				.skin.fields.filter((f) => f.options || f.required !== undefined)
				.map((f) => [f.key, [f.options ?? null, f.required ?? null]])
		);
	assert.deepEqual(controls(DEFAULT), {
		country: ['countries', true],
		city: ['cities', null]
	});
	assert.deepEqual(controls(COMMUNITY), {
		firstName: [null, true],
		country: ['countries', true],
		city: ['cities', null],
		startYear: ['years', true],
		endYear: ['years', true],
		linkedin: [null, true],
		cellCode: ['dialingCodes', null],
		sizeUnisex: ['sizes', null],
		sizeMens: ['sizes', null],
		sizeWomens: ['sizes', null]
	});
});

// Core's page documents the skin core ships; the community's own fields are
// documented in its runbook, beside the skin that declares them.
test('R6: docs/data-model.md lists every field the default skin declares, and the community runbook every field its skin does', { skip: noCommunity }, () => {
	const model =
		read('docs/data-model.md')
			.split(/^## Member fields$/m)[1]
			?.split(/^## /m)[0] ?? '';
	assert.ok(model.includes('`skin/default`'), 'docs/data-model.md does not name the default skin');
	for (const f of loadSkinDir(DEFAULT).skin.fields) {
		assert.ok(model.includes(`\`${f.key}\``), `${f.key} unlisted in docs/data-model.md`);
	}
	const runbook =
		read(`${COMMUNITY_REL}/RUNBOOK.md`)
			.split(/^## Member fields$/m)[1]
			?.split(/^## /m)[0] ?? '';
	assert.ok(runbook.includes(`\`${COMMUNITY_REL}\``), 'the runbook does not name its skin');
	for (const f of loadSkinDir(COMMUNITY).skin.fields) {
		assert.ok(runbook.includes(`\`${f.key}\``), `${f.key} unlisted in the runbook`);
	}
});

test('R6: neither skin carries a Sheet header alias', () => {
	for (const dir of SHIPPED) {
		const { skin } = loadSkinDir(dir);
		for (const f of skin.fields) {
			assert.ok(!('header' in f) && !('alias' in f), `${f.key} carries a header alias`);
		}
	}
});

// ---------------------------------------------------------------------------
// 7: the suite does not follow SKIN_DIR
// ---------------------------------------------------------------------------

test('R7: the suite runs on the default skin whatever SKIN_DIR the gate was given', () => {
	const script: string = JSON.parse(read('package.json')).scripts.test;
	assert.match(script, /^SKIN_DIR=skin\/default node /);
	assert.equal(skinDir(), 'skin/default');
	assert.deepEqual(
		DEFAULT_FIELD_SCHEMA.map(({ order: _order, ...f }) => f),
		loadSkinDir(DEFAULT).skin.fields
	);
});

// Every test file in the tree, whatever runs it: the package command's glob,
// a direct `node --test`, or a review that names one file.
function testFiles(dir = ''): string[] {
	return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
		const p = dir ? `${dir}/${e.name}` : e.name;
		if (e.isDirectory()) {
			return e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build'
				? []
				: testFiles(p);
		}
		return /\.test\.[cm]?[jt]s$/.test(e.name) ? [p] : [];
	});
}

// The tests whose subject is the skin itself: the loader and validator, and
// the checks on which skin the other tests run on. Named one by one with the
// subject that earns it; a directory or an extension earns nothing.
const SKIN_SUBJECT: Record<string, string> = {
	'src/lib/skin/skin.test.ts': 'the loader and the validator',
	'scripts/e40-review-contract.test.mjs': 'the fields the shipped default skin declares',
	'scripts/e40-review-default-tests.test.mjs': 'which skin the application tests select',
	'scripts/e40-review-default-runtime.test.mjs': 'which skin an application probe ends on',
	'scripts/e41-review-published-logo.test.mjs':
		'the email logo a community skin keeps at its published URL',
	'scripts/e42-review-theme-runtime.test.mjs':
		"the default skin's accent as a browser paints it on sign-in and in the chrome",
	'scripts/e42-review-config-concurrency.test.mjs':
		"the skin's static files staged by concurrent config loads",
	'scripts/e44-review-skin-config.test.mjs': "where the deployment guide sets the image's SKIN_DIR",
	'src/e45-split.test.ts':
		"the validator a skin repository's CI runs on its root, and the split that writes that repository",
	'scripts/e45-review-contract.test.mjs':
		"the community skin's cutover runbook, and the split's test module run in an exported core",
	'src/e46-org-repos.test.ts':
		"the one-commit split, the skin tests run in its core, and the release's default skin the upgrade boots on"
};

test('R7: no application test selects a skin, by environment, by directory or by reading another skin as data', () => {
	const all = testFiles();
	const tests = all.filter((p) => !(p in SKIN_SUBJECT));
	assert.ok(tests.filter((p) => p.startsWith('src/')).length > 50, 'src tests were not found');
	const probes = tests.filter((p) => /^scripts\/.*\.mjs$/.test(p));
	assert.ok(probes.length >= 7, 'the review probes under scripts were not found');
	for (const p of Object.keys(SKIN_SUBJECT)) assert.ok(all.includes(p), `${p} is gone`);
	const selects = (text: string) =>
		// The variable in any spelling: assigned, or handed to a child process.
		/SKIN_DIR/.test(text) ||
		// The loader pointed anywhere but at the running skin.
		/loadSkinDir\((?!skinDir\(\)\))/.test(text) ||
		/parseSkin\(|validateSkin\(/.test(text) ||
		// A shipped skin other than the default, read as a file.
		/skin\/(?!default\b)[a-z0-9-]+\/skin\.yaml|['"`]skin\/(?!default\b)/.test(text) ||
		// A skin directory built or copied for the run. One still declaring
		// `id: default` is not the shipped default. The `$skin` alias is the
		// running skin, so a module stubbed under that name selects nothing.
		/(?<!\$skin\/)skin\.yaml/.test(text) ||
		/cpSync\(\s*['"`]skin\//.test(text);
	assert.deepEqual(
		tests.filter((p) => selects(read(p))),
		[],
		'an application test must load the default skin'
	);
	// An exempt file outside the loader's own test runs no application code in
	// its own process, so the exemption cannot carry a request or an edit along.
	// Naming another exempt test, to run it in a child, loads no application code.
	const exempt = Object.keys(SKIN_SUBJECT);
	for (const p of exempt.filter((x) => x !== 'src/lib/skin/skin.test.ts')) {
		assert.doesNotMatch(
			exempt.reduce((text, other) => text.replaceAll(other, ''), read(p)),
			/\$lib\/|src\/(?!lib\/skin\/)[^'"`\s]*\.(ts|svelte)/,
			`${p} is exempt as a skin test and loads application code`
		);
	}
	// A test that needs a role the default skin leaves out replaces the field
	// schema with a list from the one fixture module, and nothing else about
	// the skin.
	const mocksSchema = tests.filter((p) => /mock\.module\([^)]*field-schema/.test(read(p)));
	const inSrc = mocksSchema.filter((p) => p.startsWith('src/'));
	assert.ok(inSrc.length >= 14, 'the tests on another field set were not found');
	assert.ok(
		mocksSchema.length - inSrc.length >= 6,
		'the probes on another field set were not found'
	);
	for (const p of inSrc) {
		assert.match(
			read(p),
			/^mock\.module\('\$lib\/server\/field-schema', \{\s*namedExports: fieldSchemaWith\([A-Z0-9_]+_FIELDS\)\s*\}\);$/m,
			`${p} replaces the field schema with something other than a field list`
		);
	}
	// A probe builds its list inline, and still hands it to the fixture.
	for (const p of mocksSchema.filter((x) => !x.startsWith('src/'))) {
		const mocks = read(p).match(/mock\.module\([^)]*field-schema[^\n]*/g) ?? [];
		for (const m of mocks) {
			assert.match(
				m,
				/^mock\.module\(file\('src\/lib\/server\/field-schema\.ts'\), \{ namedExports: (schema|fieldSchemaWith\(fields\)) \}\);$/,
				`${p} replaces the field schema with something other than a field list`
			);
		}
		if (/namedExports: schema /.test(read(p))) {
			assert.match(read(p), /^\s*const schema = fieldSchemaWith\(fields\);$/m, p);
		}
	}
	assert.ok(!existsSync(join(ROOT, 'src/lib/skin/fixtures')), 'a fixture skin directory is back');
	assert.deepEqual(
		readdirSync(join(ROOT, 'src/lib/skin')).filter((n) => /-fields\.ts$/.test(n)),
		[],
		'a per-community field module is back'
	);
});

test('R7: the field-schema fixture refuses a process running on anything but the shipped default skin', { skip: noCommunity }, (t) => {
	// A probe run by hand never passes through the package command, so the
	// fixture checks the process it is in. The copy below still says
	// `id: default`; the directory is what differs.
	const dir = scratch(t);
	const probe = `
		const { fieldSchemaWith, EVERY_ROLE_FIELDS } = await import('./src/lib/server/field-schema-fake.ts');
		fieldSchemaWith(EVERY_ROLE_FIELDS);
	`;
	const run = (skin: string | undefined) => {
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		delete env.SKIN_DIR;
		if (skin) env.SKIN_DIR = skin;
		return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], {
			cwd: ROOT,
			env,
			encoding: 'utf8',
			timeout: 30000
		});
	};
	for (const skin of [undefined, 'skin/default', DEFAULT]) {
		const ok = run(skin);
		assert.equal(ok.status, 0, `SKIN_DIR=${skin}: ${ok.stderr}`);
	}
	for (const skin of [dir, COMMUNITY_REL]) {
		const refused = run(skin);
		assert.notEqual(refused.status, 0, `SKIN_DIR=${skin} was accepted`);
		assert.match(refused.stderr, /field-schema-fake runs on skin\/default only/);
		assert.ok(refused.stderr.includes(skin), 'the refusal does not name the skin it found');
	}
});

test('R7: a replaced field schema binds every helper to the given fields and leaves the running skin alone', () => {
	const fake = fieldSchemaWith(EVERY_ROLE_FIELDS);
	assert.deepEqual(
		fake.DEFAULT_FIELD_SCHEMA.map((f) => f.key),
		EVERY_ROLE_FIELDS.map((f) => f.key)
	);
	// Every export is there, and each helper that defaults to a schema reads
	// the given one: with no schema argument, and after an omitted earlier one.
	assert.deepEqual(Object.keys(fake).sort(), Object.keys(fieldSchema).sort());
	assert.deepEqual(
		fake.nameFields().map((f) => f.key),
		['givenName', 'familyName']
	);
	assert.equal(fake.fieldByRole('publicProfile').key, 'publicProfile');
	assert.equal(fake.fieldsFor().length, EVERY_ROLE_FIELDS.length);
	assert.equal(fake.fieldsFor(['x.Extra']).length, EVERY_ROLE_FIELDS.length + 1);
	assert.equal(fake.promotedColumns({ givenName: 'Ada', familyName: 'Byron' }).name, 'Ada Byron');
	assert.deepEqual(fake.splitData({ phone: '1', city: 'X' }), {
		data: { city: 'X' },
		privateData: { phone: '1' }
	});
	// An explicit schema still wins over the bound one.
	assert.deepEqual(
		fake.nameFields(DEFAULT_FIELD_SCHEMA).map((f) => f.key),
		['name']
	);
	assert.deepEqual(
		fieldSchema.nameFields().map((f) => f.key),
		['name']
	);
	const held = new Set(EVERY_ROLE_FIELDS.map((f) => f.role));
	for (const role of FIELD_ROLES.filter((r) => r !== 'name')) {
		assert.ok(held.has(role), `the every-role field set has no ${role} field`);
	}
	// A field list the loader would refuse is refused here too.
	assert.throws(() => fieldSchemaWith(EVERY_ROLE_FIELDS.slice(2)), SkinError);
});

// A community build leaves .svelte-kit/tsconfig.json pointing `$skin` at that
// community. The test hook must still answer `$skin` from SKIN_DIR, or a test
// run after that build compares one skin's `currentSkin()` against another's
// compiled identity. The child process stands in for that state: its tsconfig
// aliases `$skin` to a skin whose slug is not the selected one.
test('E41 R6: $skin follows SKIN_DIR under the test hook, not the alias the last build left', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'skin-alias-'));
	try {
		const stale = join(tmp, 'stale');
		cpSync(join(ROOT, 'skin/default'), stale, { recursive: true });
		const yaml = join(stale, 'skin.yaml');
		writeFileSync(
			yaml,
			readFileSync(yaml, 'utf8').replace(/default_group: \S+/, 'default_group: stale')
		);
		const tsconfig = join(tmp, 'tsconfig.json');
		writeFileSync(
			tsconfig,
			JSON.stringify({
				compilerOptions: {
					paths: {
						$lib: [join(ROOT, 'src/lib')],
						'$lib/*': [join(ROOT, 'src/lib/*')],
						$skin: [stale],
						'$skin/*': [join(stale, '*')]
					}
				}
			})
		);
		const run = (hook: string) =>
			execFileSync(
				process.execPath,
				[
					'--import',
					'tsx',
					...(hook ? ['--import', hook] : []),
					'--input-type=module',
					'-e',
					"const { site } = await import('$skin/skin.yaml');" +
						"const { DEFAULT_GROUP_SLUG } = await import('./src/lib/group-nav.ts');" +
						'console.log(site.default_group, DEFAULT_GROUP_SLUG);'
				],
				{
					cwd: ROOT,
					encoding: 'utf8',
					env: { ...process.env, SKIN_DIR: 'skin/default', TSX_TSCONFIG_PATH: tsconfig }
				}
			).trim();
		assert.equal(run('./src/lib/skin/register-node.ts'), 'example example');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// E41: what each shipped skin carries that platform code no longer does
// ---------------------------------------------------------------------------

test('E41 R3: the community skin keeps the copy and the hints that were in platform code', { skip: noCommunity }, () => {
	assert.match(skinCopy('landing-hero', COMMUNITY), /^<h1>Once a .*<br>\nAlways a .*<\/h1>\n<p>/);
	assert.equal((skinCopy('landing-hero', COMMUNITY).match(/<h1[\s>]/g) ?? []).length, 1);
	assert.match(skinCopy('landing-band', COMMUNITY), /^<h2>Reconnect with your people\.<\/h2>/);
	assert.match(skinCopy('sidebar', COMMUNITY), /healthier Internet/);
	assert.match(skinCopy('affiliations-help', COMMUNITY), /select at least one/);
	// A count typed into copy is wrong the day after; none moved with the copy.
	for (const name of COPY_NAMES) {
		assert.doesNotMatch(read(`${COMMUNITY_REL}/copy/${name}.md`), /\d{2,}\+/, name);
	}
	const fields = loadSkinDir(COMMUNITY).skin.fields;
	const other = fields.find((f) => f.role === 'affiliationOther');
	assert.equal(other?.placeholder, 'e.g. Hive Network, RustCon, Common Voice');
	assert.ok(fields.find((f) => f.role === 'handle')?.placeholder);
});

test('E41 R4: a skin with a document renders it from its Markdown', { skip: noCommunity }, () => {
	assert.match(skinCopy('manifesto', COMMUNITY), /^<h1>[^<]*Manifesto<\/h1>/);
	assert.match(skinCopy('code-of-conduct', COMMUNITY), /^<h1>[^<]*Code of Conduct<\/h1>/);
	assert.equal(skinCopy('manifesto', DEFAULT), '');
	assert.equal(skinCopy('code-of-conduct', DEFAULT), '');
});

function cspFor(skin: string): Record<string, string[]> {
	const out = execFileSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			"const c = (await import('./svelte.config.js')).default; process.stdout.write(JSON.stringify(c.kit.csp.directives));"
		],
		{ cwd: ROOT, env: { ...process.env, SKIN_DIR: skin }, encoding: 'utf8' }
	);
	return JSON.parse(out);
}

test('E41 R5: the policy allows the analytics origin for a skin with an analytics block, and only then', { skip: noCommunity }, () => {
	assert.equal(loadSkinDir(DEFAULT).skin.analytics, undefined);
	assert.doesNotMatch(JSON.stringify(cspFor('skin/default')), /usefathom/);
	assert.deepEqual(loadSkinDir(COMMUNITY).skin.analytics, { provider: 'fathom', site: 'ITYUHQCY' });
	const tracked = cspFor(COMMUNITY_REL);
	for (const d of ['script-src', 'connect-src', 'img-src']) {
		assert.ok(tracked[d].includes('https://cdn.usefathom.com'), d);
	}
});

test('E41 R5: a skin cannot name an analytics provider core does not know', () => {
	const bad = defaultYaml() + 'analytics:\n  provider: tracker\n  site: X1\n';
	assert.match(
		refusal(() => parseSkin(bad, 'probe')).message,
		/analytics\.provider: found the string "tracker", expected one of fathom/
	);
});

// ---------------------------------------------------------------------------
// 8: the reference page and the released skins
// ---------------------------------------------------------------------------

test('R8: docs/skin.md has a row for every schema key, in schema order, with its type and whether it is required', () => {
	const doc = read('docs/skin.md');
	const table = doc.split('<!-- skin-keys:begin -->')[1]?.split('<!-- skin-keys:end -->')[0];
	assert.ok(table, 'docs/skin.md has no key table');
	const rows = table
		.split('\n')
		.filter((l) => l.startsWith('| `'))
		.map((l) =>
			l
				.split('|')
				.slice(1, -1)
				.map((c) => c.trim())
		);
	assert.deepEqual(
		rows.map(([key, type, required]) => ({ path: key.replace(/`/g, ''), type, required })),
		describeSkinSchema().map((r) => ({ ...r, required: r.required ? 'yes' : 'no' })),
		'docs/skin.md and the schema disagree'
	);
	for (const [key, , , fallback, example] of rows) {
		assert.ok(fallback, `${key} has no default column`);
		assert.ok(example, `${key} has no example`);
	}
});

test('R8: every released skin loads under the current schema, and one that does not fails by name', (t) => {
	const dir = join(ROOT, 'src/lib/skin/released');
	for (const { tag, skin } of loadReleasedSkins(dir)) {
		assert.ok(validateSkin(skin, tag), tag);
	}

	const scratchDir = mkdtempSync(join(tmpdir(), 'released-'));
	t.after(() => rmSync(scratchDir, { recursive: true, force: true }));
	writeFileSync(join(scratchDir, 'v0.1.0.yaml'), defaultYaml());
	assert.deepEqual(
		loadReleasedSkins(scratchDir).map((r) => r.tag),
		['v0.1.0']
	);
	// What a renamed key does to a skin written for an earlier release.
	writeFileSync(join(scratchDir, 'v0.2.0.yaml'), defaultYaml().replace('legal_name', 'operator'));
	const broke = refusal(() => loadReleasedSkins(scratchDir));
	assert.match(broke.message, /v0\.2\.0\.yaml: site\.operator: found an unknown key/);
	rmSync(join(scratchDir, 'v0.2.0.yaml'));
	writeFileSync(join(scratchDir, 'latest.yaml'), defaultYaml());
	assert.match(refusal(() => loadReleasedSkins(scratchDir)).message, /not named by a release tag/);
});

// ---------------------------------------------------------------------------
// E42: logos, static files, theme and type come from the skin
// ---------------------------------------------------------------------------

// A copy of the build inputs, with node_modules linked, so a test can build a
// skin without touching this checkout's .svelte-kit or build/.
function buildTree(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), 'skin-build-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const entry of [
		'package.json',
		'svelte.config.js',
		'vite.config.ts',
		'tsconfig.json',
		'tailwind.config.js',
		'postcss.config.js',
		'src',
		'static',
		'skin'
	]) {
		cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
	}
	symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
	return dir;
}

const runFile = promisify(execFile);

async function viteBuild(dir: string, skin: string): Promise<void> {
	await runFile(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], {
		cwd: dir,
		env: { ...process.env, SKIN_DIR: skin, NODE_ENV: 'production' },
		maxBuffer: 64 * 1024 * 1024
	});
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name));
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const { port } = server.address() as AddressInfo;
	await new Promise((done) => server.close(done));
	return port;
}

// Starts a built tree's server and returns what it answers for each path.
async function serve(dir: string, skin: string, paths: string[]): Promise<Map<string, Buffer>> {
	const port = await freePort();
	const child = spawn(process.execPath, ['build/index.js'], {
		cwd: dir,
		env: {
			...process.env,
			SKIN_DIR: skin,
			PORT: String(port),
			HOST: '127.0.0.1',
			MAIL_TRANSPORT: 'smtp',
			SMTP_HOST: 'localhost'
		},
		stdio: 'ignore'
	});
	try {
		const got = new Map<string, Buffer>();
		for (let i = 0; i < 100; i++) {
			try {
				await fetch(`http://127.0.0.1:${port}/healthz`);
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		for (const path of paths) {
			const res = await fetch(`http://127.0.0.1:${port}${path}`);
			assert.equal(res.status, 200, `${skin}: ${path} answered ${res.status}`);
			got.set(path, Buffer.from(await res.arrayBuffer()));
		}
		return got;
	} finally {
		child.kill();
	}
}

const BRANDED_FILES = [
	'favicon.svg',
	'favicon.ico',
	'apple-touch-icon.png',
	'imgs/wordmark.svg',
	'imgs/wordmark.png',
	'imgs/mark.svg',
	'email/shared/logo.png',
	`email/shared/${COMMUNITY_ID}-logo.png`,
	...['Regular', 'Italic'].flatMap((style) =>
		['ttf', 'woff', 'woff2'].map((ext) => `fonts/InstrumentSerif/InstrumentSerif-${style}.${ext}`)
	)
];

test('E42 R1: core static keeps only robots.txt, and the community skin carries every branded file', { skip: noCommunity }, () => {
	const tracked = execFileSync('git', ['ls-files', 'static'], { cwd: ROOT, encoding: 'utf8' });
	assert.deepEqual(tracked.trim().split('\n'), ['static/robots.txt']);
	for (const file of BRANDED_FILES) {
		assert.ok(existsSync(join(COMMUNITY, 'static', file)), `${COMMUNITY_REL}/static/${file}`);
	}
	// The default skin draws its own wordmark and icon rather than reusing the
	// community's.
	for (const file of [
		'imgs/wordmark.svg',
		'imgs/mark.svg',
		'favicon.ico',
		'apple-touch-icon.png'
	]) {
		assert.ok(existsSync(join(DEFAULT, 'static', file)), `skin/default/static/${file}`);
		assert.notDeepEqual(
			readFileSync(join(DEFAULT, 'static', file)),
			readFileSync(join(COMMUNITY, 'static', file)),
			`skin/default/static/${file} is the community's`
		);
	}
});

test('E42 R1: staging puts the skin static files beside core, and refuses one that takes a URL core or SvelteKit serves', (t) => {
	const tmp = mkdtempSync(join(tmpdir(), 'skin-assets-'));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const core = join(tmp, 'core');
	const skin = join(tmp, 'skin');
	const out = join(tmp, 'out');
	for (const [path, body] of [
		[join(core, 'robots.txt'), 'core'],
		[join(skin, 'static/imgs/wordmark.svg'), 'skin'],
		[join(skin, 'static/imgs/dropped.svg'), 'removed below']
	]) {
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, body);
	}
	const staged = (dir: string) =>
		filesUnder(dir)
			.map((p) => p.slice(dir.length + 1))
			.sort();
	const first = stageSkinAssets(skin, { core, out });
	assert.equal(join(first, '..'), out);
	assert.deepEqual(staged(first), ['imgs/dropped.svg', 'imgs/wordmark.svg', 'robots.txt']);
	assert.equal(stageSkinAssets(skin, { core, out }), first, 'same inputs, same directory');
	rmSync(join(skin, 'static/imgs/dropped.svg'));
	const second = stageSkinAssets(skin, { core, out });
	assert.notEqual(second, first);
	assert.deepEqual(staged(second), ['imgs/wordmark.svg', 'robots.txt'], 'a dropped file is not served');
	assert.deepEqual(
		staged(first),
		['imgs/dropped.svg', 'imgs/wordmark.svg', 'robots.txt'],
		'a later load leaves an earlier one\'s directory alone'
	);
	assert.deepEqual(readdirSync(out).sort(), [first, second].map((d) => d.slice(out.length + 1)).sort());
	writeFileSync(join(skin, 'static/robots.txt'), 'skin');
	assert.throws(() => stageSkinAssets(skin, { core, out }), /static\/robots\.txt: core's/);
	rmSync(join(skin, 'static/robots.txt'));
	mkdirSync(join(skin, 'static/_app'));
	writeFileSync(join(skin, 'static/_app/version.json'), '{}');
	assert.throws(
		() => stageSkinAssets(skin, { core, out }),
		/_app\/version\.json: \/_app is SvelteKit's/
	);
	assert.match(read('svelte.config.js'), /files: \{ assets: stageSkinAssets\(skinDir\) \}/);
	const doc = read('docs/skin.md');
	const section = doc.split('\n## Static files\n')[1]?.split('\n## ')[0] ?? '';
	for (const said of [
		'`src/lib/skin/assets.js`',
		'`kit.files.assets`',
		'is refused rather than allowed to replace it',
		'SKIN_DIR=skin/one pnpm build && cmp build/client/imgs/wordmark.svg skin/one/static/imgs/wordmark.svg',
		'SKIN_DIR=skin/two pnpm build && cmp build/client/imgs/wordmark.svg skin/two/static/imgs/wordmark.svg'
	]) {
		assert.ok(section.includes(said), `docs/skin.md, Static files: ${said}`);
	}
});

test('E42 R1: two skins shipping the same file name build two sites serving different bytes at its URL', async (t) => {
	const builds = ['one', 'two'].map((name) => {
		const dir = buildTree(t);
		const skin = join(dir, 'skin', name);
		cpSync(join(dir, 'skin/default'), skin, { recursive: true });
		writeFileSync(
			join(skin, 'static/imgs/wordmark.svg'),
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>${name}</title></svg>`
		);
		return { dir, name, skin: `skin/${name}` };
	});
	await Promise.all(builds.map((b) => viteBuild(b.dir, b.skin)));
	const served = await Promise.all(
		builds.map((b) => serve(b.dir, b.skin, ['/imgs/wordmark.svg', '/robots.txt']))
	);
	builds.forEach((b, i) => {
		const own = readFileSync(join(b.dir, b.skin, 'static/imgs/wordmark.svg'));
		assert.deepEqual(readFileSync(join(b.dir, 'build/client/imgs/wordmark.svg')), own, b.name);
		assert.deepEqual(served[i].get('/imgs/wordmark.svg'), own, `${b.name}: served bytes`);
	});
	assert.notDeepEqual(served[0].get('/imgs/wordmark.svg'), served[1].get('/imgs/wordmark.svg'));
	assert.deepEqual(served[0].get('/robots.txt'), readFileSync(join(ROOT, 'static/robots.txt')));
});

test('E42 R2: brand names the wordmark, the mark and the email logo, by what they are, and each must exist', (t) => {
	for (const dir of SHIPPED) {
		const { skin } = loadSkinDir(dir);
		assert.deepEqual(Object.keys(skin.brand), ['wordmark', 'mark', 'email_logo']);
		for (const path of Object.values(skin.brand)) {
			assert.ok(existsSync(join(dir, 'static', path)), `${dir}: ${path}`);
			assert.ok(!path.includes(skin.id), `${dir}: ${path} names its owner`);
		}
	}
	const missing = scratch(t, (y) =>
		y.replace('wordmark: imgs/wordmark.svg', 'wordmark: imgs/gone.svg')
	);
	assert.match(
		refusal(() => loadSkinDir(missing)).message,
		/brand\.wordmark: found nothing at static\/imgs\/gone\.svg, expected a file in the skin's static directory/
	);
	for (const bad of ['/imgs/wordmark.svg', '../theme.css', 'imgs/../../x.svg', '.hidden.svg']) {
		const dir = scratch(t, (y) => y.replace('wordmark: imgs/wordmark.svg', `wordmark: ${bad}`));
		assert.match(refusal(() => loadSkinDir(dir)).message, /brand\.wordmark: found the string/, bad);
	}
	const svgMail = scratch(t, (y) =>
		y.replace('email_logo: email/shared/logo.png', 'email_logo: imgs/mark.svg')
	);
	assert.match(
		refusal(() => loadSkinDir(svgMail)).message,
		/brand\.email_logo: .*expected a \.png path/
	);
	const noIcon = scratch(t);
	rmSync(join(noIcon, 'static/favicon.ico'));
	assert.match(refusal(() => loadSkinDir(noIcon)).message, /static\/favicon\.ico: found nothing/);
});

const LOGO_SITES = [
	'src/lib/components/Landing.svelte',
	'src/lib/components/Sidebar.svelte',
	'src/lib/components/LoginModal.svelte',
	'src/lib/components/TopNav.svelte',
	'src/routes/(auth)/login/+page.svelte',
	'src/routes/(auth)/auth/magic/+page.svelte',
	'src/routes/group/[slug]/+layout.svelte',
	'src/routes/group/[slug]/request/+page.svelte'
];

test('E42 R2: every logo on a page is the skin wordmark, described by the skin display name', { skip: noCommunity }, () => {
	for (const file of LOGO_SITES) {
		const imgs = read(file).match(/<img\s[^>]*>/g) ?? [];
		const logos = imgs.filter((tag) => /wordmark/.test(tag));
		assert.equal(logos.length, 1, `${file}: ${imgs.join(' | ')}`);
		assert.match(logos[0], /src="\/\{(?:brand|skinBrand)\.wordmark\}"/, file);
		assert.match(logos[0], /alt=\{site\.name\}/, file);
	}
	// The pages, the page head and both messages; hooks.server.ts and
	// site-gate.ts still match these URLs by prefix, which names no file.
	const literals = [
		...LOGO_SITES,
		'src/app.html',
		'src/routes/+layout.svelte',
		'src/lib/server/email.ts',
		'src/lib/server/magic-link-template.ts'
	].filter((p) => /\/imgs\/|email\/shared\/|favicon\.svg|logo\.(?:svg|png)/.test(read(p)));
	assert.deepEqual(literals, [], 'a platform file names a logo file');
	assert.match(
		read('src/lib/server/email.ts'),
		/\$\{APP_BASE_URL\}\/\$\{brand\.email_logo\}" alt="\$\{esc\(site\.name\)\}"/
	);
	assert.match(
		read('src/lib/server/magic-link-template.ts'),
		/<img src="%%BASE_URL%%\/%%EMAIL_LOGO%%" alt="%%SITE_NAME%%"/
	);
	assert.match(read('src/routes/+layout.svelte'), /<link\s+rel="icon"\s+href="\/\{brand\.mark\}"/);
	assert.match(
		skinModuleSource(loadSkinDir(COMMUNITY)),
		/^export const brand = \{"wordmark":"imgs\/wordmark\.svg","mark":"imgs\/mark\.svg","email_logo":"email\/shared\/logo\.png"\};$/m
	);
});

test('E42 R3: Tailwind binds the accent, its contrast, the link color and both font families to theme properties', async () => {
	const { default: config } = await import(join(ROOT, 'tailwind.config.js'));
	const { colors, fontFamily } = config.theme.extend;
	assert.deepEqual(colors, {
		accent: { DEFAULT: 'var(--color-accent)', contrast: 'var(--color-accent-contrast)' },
		link: 'var(--color-link)'
	});
	assert.deepEqual(fontFamily, { serif: 'var(--font-serif)', sans: 'var(--font-sans)' });
	assert.match(
		read('src/routes/+layout.svelte'),
		/import '\$lib\/styles\/app\.css';[\s\S]*import '\$skin\/theme\.css';/
	);
	for (const file of [
		'src/lib/components/Landing.svelte',
		'src/routes/group/[slug]/admin/+page.svelte',
		'src/routes/group/[slug]/admin/landing/+page.svelte',
		'src/routes/group/[slug]/admin/requests/+page.svelte',
		'src/routes/group/[slug]/admin/audit/+page.svelte',
		'src/routes/group/[slug]/members/[id]/+page.svelte'
	]) {
		assert.doesNotMatch(read(file), /\b(?:cyan|rose)-\d/, file);
	}
	assert.match(read('src/lib/components/Landing.svelte'), /prose-a:text-link/);
	const admin = read('src/routes/group/[slug]/admin/landing/+page.svelte');
	assert.match(admin, /bg-accent [^"]*text-accent-contrast/);
	assert.match(admin, /focus:border-accent focus:ring-accent/);
});

test('E42 R3: every sign-in and landing primary paints the skin accent', () => {
	const primaries: [string, number][] = [
		['src/routes/(auth)/login/+page.svelte', 1],
		['src/lib/components/LoginModal.svelte', 1],
		// Both calls to action and the skip link's focus state.
		['src/lib/components/Landing.svelte', 3],
		['src/routes/(auth)/auth/magic/+page.svelte', 3]
	];
	for (const [file, count] of primaries) {
		const source = read(file);
		const accent = source.match(/\bbg-accent [^"]*text-accent-contrast[^"]*"/g) ?? [];
		assert.equal(accent.length, count, file);
		for (const cls of accent) assert.doesNotMatch(cls, /\b(?:bg|text)-(?:black|white)\b/, file);
		assert.doesNotMatch(source, /dark:bg-white dark:text-black|focus:bg-black/, file);
	}
});

test("E42 R3: the community theme keeps today's primaries and type, and the page head and mail read the accent", { skip: noCommunity }, () => {
	const { theme } = loadSkinDir(COMMUNITY);
	// bg-black text-white, and dark:bg-white dark:text-black, as the sign-in
	// buttons and both messages render them.
	assert.deepEqual(
		[theme.light.accent, theme.light.accentContrast, theme.dark.accent, theme.dark.accentContrast],
		['#000000', '#ffffff', '#ffffff', '#000000']
	);
	const css = read(`${COMMUNITY_REL}/theme.css`).replace(/\s+/g, ' ');
	assert.match(
		css,
		/--font-sans: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;/
	);
	assert.match(css, /--font-serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;/);
	// The server renders the light accent; the pre-paint script and the toggle
	// rewrite it from the page's own --color-accent in whichever mode is active.
	// scripts/e42-review-theme-runtime.test.mjs drives that in a browser.
	assert.doesNotMatch(read('src/app.html'), /<meta name="theme-color"/);
	assert.match(
		read('src/routes/+layout.svelte'),
		/<meta name="theme-color" content=\{theme\.light\.accent\} \/>/
	);
	const repaint =
		/getPropertyValue\('--color-accent'\)[\s\S]*querySelector\('meta\[name="theme-color"\]'\)[\s\S]*setAttribute\('content', accent\)/;
	const app = read('src/app.html');
	assert.match(app, repaint);
	assert.ok(app.indexOf('%sveltekit.head%') < app.indexOf('<script'), 'pre-paint script runs after the head');
	const toggle = read('src/lib/components/ThemeToggle.svelte');
	assert.match(toggle, repaint);
	assert.match(toggle, /classList\.toggle\('dark', dark\);\s*paintThemeColor\(\);/);
	assert.match(toggle, /onMount\(\(\) => \{[\s\S]*paintThemeColor\(\);/);
	assert.match(
		skinModuleSource(loadSkinDir(COMMUNITY)),
		/^export const theme = \{"light":\{"accent":"#000000"/m
	);
	const template = read('src/lib/server/magic-link-template.ts');
	assert.doesNotMatch(template, /background-color: #000|color: #(?:fff|000)\b/);
	assert.equal((template.match(/%%ACCENT%%/g) ?? []).length, 3);
	assert.doesNotMatch(read('src/lib/server/email.ts'), /background:#000|color:#fff/);
});

test('E42 R3: theme.css holds the named properties and nothing else, and a color is hex', (t) => {
	const withTheme = (css: string) => {
		const dir = scratch(t);
		writeFileSync(join(dir, 'theme.css'), css);
		return refusal(() => loadSkinDir(dir)).message;
	};
	const base = read('skin/default/theme.css');
	assert.match(
		withTheme(base + '\nbody { color: red; }'),
		/theme\.css: body: found a selector core does not read/
	);
	assert.match(
		withTheme(base.replace('--font-serif', '--font-mono')),
		/:root --font-mono: found an unknown property/
	);
	assert.match(
		withTheme(
			base.replace(
				'#a5b4fc;\n\t--color-accent-contrast',
				'rebeccapurple;\n\t--color-accent-contrast'
			)
		),
		/\.dark --color-accent: found "rebeccapurple", expected a hex color/
	);
	assert.match(
		withTheme(base.replace(/\.dark \{[\s\S]*\}/, '')),
		/\.dark --color-link: found nothing/
	);
	assert.match(
		withTheme(base + "\n@import url('/x.css');"),
		/@import: found an at-rule core does not read/
	);
	assert.match(withTheme('a {'), /invalid CSS/);
});

test('E42 R4: @font-face is the skin that ships the face; the default ships a system stack and no font file', { skip: noCommunity }, () => {
	assert.doesNotMatch(read('src/lib/styles/app.css'), /@font-face|Instrument Serif/);
	const community = read(`${COMMUNITY_REL}/theme.css`);
	assert.equal(
		(community.match(/@font-face \{\s*font-family: 'Instrument Serif';/g) ?? []).length,
		2
	);
	assert.match(community, /url\('\/fonts\/InstrumentSerif\/InstrumentSerif-Regular\.woff2'\)/);
	const fallback = read('skin/default/theme.css');
	assert.doesNotMatch(fallback, /@font-face|url\(/);
	assert.match(fallback, /--font-sans: system-ui,/);
	const fonts = filesUnder(join(DEFAULT, 'static')).filter((p) => /\.(?:ttf|otf|woff2?)$/i.test(p));
	assert.deepEqual(fonts, []);
});

test('E42 R5: the OFL ships beside Instrument Serif, and the MIT notice for md5.ts at the root', { skip: noCommunity }, () => {
	const ofl = read(`${COMMUNITY_REL}/static/fonts/InstrumentSerif/OFL.txt`);
	assert.match(
		ofl,
		/^Copyright 2022 The Instrument Serif Project Authors \(https:\/\/github\.com\/Instrument\/instrument-serif\)$/m
	);
	assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
	assert.match(
		ofl,
		/5\) The Font Software, modified or unmodified, in part or in whole,\s+must be distributed entirely under this license/
	);
	const notices = read('THIRD_PARTY_NOTICES.md');
	assert.match(notices, /`src\/lib\/md5\.ts` is a TypeScript port of \[JavaScript MD5\]/);
	assert.match(notices, /MIT License\s+Copyright © 2011 Sebastian Tschan, https:\/\/blueimp\.net/);
	assert.match(
		notices,
		/The above copyright notice and this permission notice shall be included in all\s+copies or substantial portions of the Software\./
	);
	assert.match(read('src/lib/md5.ts'), /blueimp-md5 \(MIT/);
});

test('E42 R6: each shipped skin clears the 4.5:1 floor, accent against its contrast and against every page background', () => {
	assert.equal(CONTRAST_FLOOR, 4.5);
	assert.equal(contrastRatio('#000000', '#ffffff'), 21);
	assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
	// cyan-600 under white text, the old admin Save button.
	assert.ok(contrastRatio('#0891b2', '#ffffff') < 4.5);
	for (const dir of SHIPPED) {
		const { theme } = loadSkinDir(dir);
		for (const mode of ['light', 'dark'] as const) {
			const c = theme[mode];
			const at = `${dir} ${mode}`;
			assert.ok(contrastRatio(c.accent, c.accentContrast) >= 4.5, `${at}: accent on its contrast`);
			for (const bg of PAGE_BACKGROUNDS[mode]) {
				assert.ok(contrastRatio(c.accent, bg) >= 4.5, `${at}: accent on ${bg}`);
				assert.ok(contrastRatio(c.link, bg) >= 4.5, `${at}: link on ${bg}`);
			}
		}
	}
});

test('E42 R6: the loader refuses a theme under the floor, naming the pair and the ratio', (t) => {
	const dir = scratch(t);
	writeFileSync(
		join(dir, 'theme.css'),
		read('skin/default/theme.css').replace('--color-accent: #4338ca', '--color-accent: #0891b2')
	);
	assert.match(
		refusal(() => loadSkinDir(dir)).message,
		/:root --color-accent: found #0891b2, 3\.68:1 against --color-accent-contrast, expected at least 4\.5:1/
	);
	const css = read('skin/default/theme.css');
	assert.throws(
		() => readTheme(css.replace('--color-link: #a5b4fc', '--color-link: #333333'), 'x'),
		/\.dark --color-link: found #333333, [\d.]+:1 against the dark page #0a0a0a/
	);
});

// A source map's `sources` are paths from the map to its inputs. node_modules in
// a build tree is a symlink to the checkout, and the checkout's node_modules may
// itself point at an installation elsewhere, so those paths spell out
// directories above every tree (the checkout, a dependency cache), which in a
// community's own CI are named after the community. Each source is judged by
// where it sits inside the tree it came from, the deepest matching root
// winning, and the map by the code and names it carries. A source under no
// known root stays relative to the checkout and is judged in full.
function shippedText(file: string, tree: string): string {
	const text = readFileSync(file, 'latin1');
	if (!file.endsWith('.map')) return text;
	const map = JSON.parse(text) as {
		sources?: string[];
		sourcesContent?: (string | null)[];
		names?: string[];
	};
	const root = realpathSync(ROOT);
	const built = realpathSync(tree);
	const roots: { dir: string; as: string }[] = [
		{ dir: built, as: '' },
		{ dir: root, as: '' },
		...[join(tree, 'node_modules'), join(ROOT, 'node_modules')]
			.filter((d) => existsSync(d))
			.map((d) => ({ dir: realpathSync(d), as: 'node_modules' }))
	].sort((a, b) => b.dir.length - a.dir.length);
	const from = realpathSync(dirname(file));
	const sources = (map.sources ?? []).map((s) => {
		const abs = resolve(from, s);
		const hit = roots.find(({ dir }) => abs.startsWith(dir + sep));
		return hit ? join(hit.as, relative(hit.dir, abs)) : relative(root, abs);
	});
	return [...sources, ...(map.sourcesContent ?? []), ...(map.names ?? [])].join('\n');
}

test('E45: a source map is judged by what it carries, not by the checkout path its sources walk through', { skip: noCommunity }, (t) => {
	const tree = scratch(t);
	mkdirSync(join(tree, 'build'));
	const map = join(tree, 'build', 'x.js.map');
	const viaCheckout = relative(
		join(realpathSync(tree), 'build'),
		join(realpathSync(ROOT), 'node_modules/x/index.js')
	);
	writeFileSync(map, JSON.stringify({ sources: [viaCheckout], sourcesContent: ['x'], names: [] }));
	assert.doesNotMatch(shippedText(map, tree), new RegExp(COMMUNITY_ID, 'i'));
	writeFileSync(
		map,
		JSON.stringify({
			sources: [`../skin/${COMMUNITY_ID}/copy/x.md`],
			sourcesContent: ['x'],
			names: []
		})
	);
	assert.match(shippedText(map, tree), new RegExp(COMMUNITY_ID, 'i'));
	writeFileSync(
		map,
		JSON.stringify({ sources: ['../src/x.ts'], sourcesContent: [`see ${COMMUNITY_ID}`], names: [] })
	);
	assert.match(shippedText(map, tree), new RegExp(COMMUNITY_ID, 'i'));
});

test('E45: a source map is judged by what it carries, not by where its dependencies are installed', { skip: noCommunity }, (t) => {
	const tree = scratch(t);
	const cache = mkdtempSync(join(tmpdir(), `${COMMUNITY_ID}-dependencies-`));
	t.after(() => rmSync(cache, { recursive: true, force: true }));
	mkdirSync(join(cache, 'node_modules', 'x'), { recursive: true });
	symlinkSync(join(cache, 'node_modules'), join(tree, 'node_modules'));
	mkdirSync(join(tree, 'build'));
	const map = join(tree, 'build', 'x.js.map');
	const external = relative(
		join(realpathSync(tree), 'build'),
		join(realpathSync(cache), 'node_modules/x/index.js')
	);
	writeFileSync(map, JSON.stringify({ sources: [external], sourcesContent: ['x'], names: [] }));
	assert.equal(shippedText(map, tree), ['node_modules/x/index.js', 'x'].join('\n'));
	writeFileSync(
		map,
		JSON.stringify({
			sources: [external.replace('/x/index.js', `/${COMMUNITY_ID}-theme/index.js`)],
			sourcesContent: ['x'],
			names: []
		})
	);
	assert.match(shippedText(map, tree), new RegExp(COMMUNITY_ID, 'i'));
	writeFileSync(
		map,
		JSON.stringify({ sources: [external], sourcesContent: ['x'], names: [COMMUNITY_ID] })
	);
	assert.match(shippedText(map, tree), new RegExp(COMMUNITY_ID, 'i'));
});

test('E42 R7: a default build names no file after the community and carries no reference to it', { skip: noCommunity }, async (t) => {
	const dir = buildTree(t);
	await viteBuild(dir, 'skin/default');
	const files = filesUnder(join(dir, 'build'));
	assert.ok(
		files.some((p) => p.endsWith('/client/imgs/wordmark.svg')),
		'the build was not found'
	);
	const pattern = new RegExp(COMMUNITY_ID, 'i');
	assert.deepEqual(
		files.filter((p) => pattern.test(p.slice(dir.length))),
		[],
		'a built file is named after the community'
	);
	assert.deepEqual(
		files.filter((p) => pattern.test(shippedText(p, dir))),
		[],
		'a built file names the community'
	);
});
