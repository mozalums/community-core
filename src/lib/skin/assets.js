// The static files a build serves: core's `static/` and the selected skin's
// `static/`, copied into one directory that svelte.config.js names as
// `kit.files.assets`. SvelteKit serves one assets directory and lists it in
// its manifest, so the skin's files reach the same root URLs core's own do, in
// `vite dev` and in the built server alike. Plain JavaScript because
// svelte.config.js imports it.
//
// Every process that imports svelte.config.js stages, and several run at once
// (the test runner's files, `vite dev` beside `pnpm check`). So a staged
// directory is named by the hash of what it holds, built under a private name
// and published with one rename, and never written or deleted after that: two
// loads with the same inputs share a finished directory, two with different
// inputs never touch each other's, and a file dropped from a skin is absent
// because the changed hash names a new directory.
//
// Reuse by name is only sound if the name describes the bytes. Each source file
// is read once, and those buffers are what get validated, hashed and written;
// copying the source trees after hashing them lets an edit land between the two
// reads and files the edited bytes under the original key, where every later
// build with the original inputs would find and serve them.

import { createHash, randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const CORE_ASSETS_DIR = 'static';
export const STAGED_ASSETS_DIR = '.svelte-kit/skin-assets';

// SvelteKit writes its bundles under /_app, so a static file there would sit
// beside, or replace, a compiled one.
const RESERVED = /^_app(?:\/|$)/;

// Part of every key, so a directory staged by an earlier layout of this
// function, whose contents need not match its name, is never reused.
const KEY_VERSION = 'snapshot-v1';

/** @param {string} dir @returns {string[]} */
function files(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile())
		.map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
		.sort();
}

/**
 * Stages core's static files and the skin's under `out`, and returns the
 * staged directory: `out/<hash of the merged files>`.
 * A skin file at a path core already serves is refused rather than allowed to
 * shadow it: core keeps only files no community replaces, so a clash is a file
 * in the wrong tree.
 *
 * @param {string} skinDir
 * @param {{ core?: string, out?: string }} [dirs]
 * @returns {string}
 */
export function stageSkinAssets(skinDir, { core = CORE_ASSETS_DIR, out = STAGED_ASSETS_DIR } = {}) {
	const skinStatic = join(skinDir, 'static');
	/** @param {string} dir */
	const capture = (dir) =>
		files(dir).map((path) => ({ path, body: readFileSync(join(dir, path)) }));
	const coreFiles = capture(core);
	const skinFiles = capture(skinStatic);
	const corePaths = new Set(coreFiles.map((f) => f.path));
	const refused = skinFiles.flatMap(({ path }) => {
		if (corePaths.has(path))
			return [`${skinStatic}/${path}: core's ${core}/${path} serves /${path}`];
		if (RESERVED.test(path)) return [`${skinStatic}/${path}: /_app is SvelteKit's`];
		return [];
	});
	if (refused.length) {
		throw new Error(
			`A skin's static file may not take a URL core or SvelteKit serves:\n${refused.join('\n')}`
		);
	}
	const snapshot = [...coreFiles, ...skinFiles].sort((a, b) => (a.path < b.path ? -1 : 1));
	const hash = createHash('sha256').update(`${KEY_VERSION}\0`);
	for (const { path, body } of snapshot) hash.update(`${path}\0${body.length}\0`).update(body);
	const staged = join(out, hash.digest('hex').slice(0, 16));
	if (existsSync(staged)) return staged;
	mkdirSync(out, { recursive: true });
	const building = join(out, `.building-${process.pid}-${randomUUID()}`);
	try {
		mkdirSync(building);
		for (const { path, body } of snapshot) {
			const target = join(building, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, body);
		}
		renameSync(building, staged);
	} catch (err) {
		// Another load published the same hash first, so the same files.
		if (!existsSync(staged)) throw err;
	} finally {
		rmSync(building, { recursive: true, force: true });
	}
	return staged;
}
