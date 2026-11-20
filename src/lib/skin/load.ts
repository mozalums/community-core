// Reads a skin directory: skin.yaml, copy/, theme.css and static/. Node only.
// The build calls it through `skinPlugin`, the server calls it at boot and for
// the field schema, and both get the same refusals.

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { SKIN_SCHEMA, SkinError, parseSkin, type Skin, type SkinIssue } from './schema';
import { readTheme, type Theme } from './theme';

export const SKIN_FILE = 'skin.yaml';
export const DEFAULT_SKIN_DIR = 'skin/default';

// A skin is data. With none of these in it, a skin change cannot add code to
// the server or the page, so it can be reviewed without reading any.
export const CODE_EXTENSIONS: readonly string[] = [
	'.svelte',
	'.ts',
	'.mts',
	'.cts',
	'.tsx',
	'.js',
	'.mjs',
	'.cjs',
	'.jsx'
];

const LAYOUT: readonly { name: string; kind: 'file' | 'directory' }[] = [
	{ name: SKIN_FILE, kind: 'file' },
	{ name: 'copy', kind: 'directory' },
	{ name: 'theme.css', kind: 'file' },
	{ name: 'static', kind: 'directory' }
];

// src/app.html links these by fixed URL, so every skin's static/ holds them.
export const HEAD_ASSETS: readonly string[] = ['favicon.ico', 'apple-touch-icon.png'];

export type LoadedSkin = { dir: string; file: string; text: string; skin: Skin; theme: Theme };

// Relative to the working directory, which is the repository root for the
// build, the tests and the scripts, and /app in the image.
export function skinDir(env: Record<string, string | undefined> = process.env): string {
	return env.SKIN_DIR?.trim() || DEFAULT_SKIN_DIR;
}

function kindOf(path: string): 'file' | 'directory' | 'symlink' | 'missing' | 'other' {
	const st = lstatSync(path, { throwIfNoEntry: false });
	if (!st) return 'missing';
	if (st.isSymbolicLink()) return 'symlink';
	if (st.isDirectory()) return 'directory';
	return st.isFile() ? 'file' : 'other';
}

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const path = join(dir, e.name);
		return e.isDirectory() ? [path, ...walk(path)] : [path];
	});
}

export function loadSkinDir(dir: string): LoadedSkin {
	const file = join(dir, SKIN_FILE);
	const issues = [];
	if (kindOf(dir) !== 'directory') {
		throw new SkinError(dir, [
			{ path: '', found: `${kindOf(dir)} at SKIN_DIR`, expected: 'a skin directory' }
		]);
	}
	for (const path of walk(dir)) {
		const name = relative(dir, path);
		// A link is refused whatever it is named: it can point at code outside
		// the directory the review covered.
		if (kindOf(path) === 'symlink') {
			issues.push({ path: name, found: 'a symbolic link', expected: 'a regular file' });
		} else if (CODE_EXTENSIONS.includes(extname(path).toLowerCase())) {
			issues.push({
				path: name,
				found: 'a code file',
				expected: `no ${CODE_EXTENSIONS.join(', ')} file in a skin (a skin is data)`
			});
		}
	}
	for (const { name, kind } of LAYOUT) {
		const found = kindOf(join(dir, name));
		if (found !== kind && found !== 'symlink') {
			issues.push({
				path: name,
				found: found === 'missing' ? 'nothing' : `a ${found}`,
				expected: `a ${kind}`
			});
		}
	}
	if (issues.length) throw new SkinError(dir, issues);
	const text = readFileSync(file, 'utf8');
	const skin = parseSkin(text, file);
	const absent = (asset: string) => kindOf(join(dir, 'static', asset)) !== 'file';
	const unbranded: SkinIssue[] = Object.entries(skin.brand)
		.filter(([, asset]) => absent(asset))
		.map(([key, asset]) => ({
			path: `brand.${key}`,
			found: `nothing at static/${asset}`,
			expected: "a file in the skin's static directory"
		}));
	if (unbranded.length) throw new SkinError(file, unbranded);
	const unlinked: SkinIssue[] = HEAD_ASSETS.filter(absent).map((asset) => ({
		path: `static/${asset}`,
		found: 'nothing',
		expected: 'a file (every page links it)'
	}));
	if (unlinked.length) throw new SkinError(dir, unlinked);
	const themeFile = join(dir, 'theme.css');
	return { dir, file, text, skin, theme: readTheme(readFileSync(themeFile, 'utf8'), themeFile) };
}

let current: LoadedSkin | undefined;

// The skin this process runs with, read once.
export function currentSkin(): LoadedSkin {
	return (current ??= loadSkinDir(skinDir()));
}

// The boot check. `built` is the skin.yaml text the bundle was compiled from.
// A container whose SKIN_DIR holds anything else would serve pages whose
// compiled-in identity came from one skin and whose field schema came from
// another, so a difference is refused as firmly as an unreadable skin.
export function assertSkinAtBoot(built: string, dir: string = skinDir()): LoadedSkin {
	const loaded = loadSkinDir(dir);
	if (loaded.text !== built) {
		throw new SkinError(loaded.file, [
			{
				path: '',
				found: 'a skin.yaml that differs from the one this build was compiled with',
				expected: 'the skin directory the image was built from; rebuild with this SKIN_DIR'
			}
		]);
	}
	return loaded;
}

// skin.yaml as a module with one named export per top-level key, so a page
// that reads `site` does not ship `fields` to the browser. Every key the schema
// declares is exported, an absent optional one as `undefined`, so a page can
// import `analytics` from a skin that leaves it out. `theme` is theme.css's
// colors, for the readers a custom property cannot reach: mail and the page head.
export function skinModuleSource({ skin, theme }: Pick<LoadedSkin, 'skin' | 'theme'>): string {
	return Object.keys(SKIN_SCHEMA.keys)
		.map((key) => {
			const value = (skin as Record<string, unknown>)[key];
			return `export const ${key} = ${value === undefined ? 'undefined' : JSON.stringify(value)};\n`;
		})
		.concat(`export const theme = ${JSON.stringify(theme)};\n`)
		.join('');
}

// Fails the build on a skin the loader refuses, and serves `$skin/skin.yaml`.
export function skinPlugin(dir: string = skinDir()): Plugin {
	const file = resolve(dir, SKIN_FILE);
	return {
		name: 'skin',
		enforce: 'pre',
		buildStart() {
			loadSkinDir(dir);
		},
		load(id) {
			return id === file ? skinModuleSource(loadSkinDir(dir)) : null;
		}
	};
}

const RELEASE_FILE = /^v\d+\.\d+\.\d+\.yaml$/;

// One skin.yaml per core release, named by tag. Each must load under the
// current schema; one that stops loading is a breaking change.
export function loadReleasedSkins(dir: string): { tag: string; skin: Skin }[] {
	return readdirSync(dir)
		.filter((name) => name.endsWith('.yaml'))
		.sort()
		.map((name) => {
			const file = join(dir, name);
			if (!RELEASE_FILE.test(name)) {
				throw new SkinError(file, [
					{
						path: '',
						found: 'a file not named by a release tag',
						expected: 'v<major>.<minor>.<patch>.yaml'
					}
				]);
			}
			return {
				tag: name.slice(0, -'.yaml'.length),
				skin: parseSkin(readFileSync(file, 'utf8'), file)
			};
		});
}
