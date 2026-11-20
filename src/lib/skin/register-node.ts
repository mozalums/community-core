// Loaded with `node --import` by `pnpm test`. Under Vite, `skinPlugin` serves
// `$skin/skin.yaml` as a module; under plain Node the same import reaches the
// YAML file itself and fails on its extension. This hook answers it the way
// the plugin does, through the same loader, so a module shared by the browser
// and the server (group-nav.ts) can read the skin and still be tested.
//
// `$skin` resolves here, from SKIN_DIR, rather than through the alias in
// .svelte-kit/tsconfig.json: that file records whichever skin the last sync or
// build selected, so a test run after a community build would otherwise import
// that community's identity while `currentSkin()` reads the default.

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SKIN_FILE, loadSkinDir, skinDir, skinModuleSource } from './load';

const ALIAS = '$skin/';

registerHooks({
	// The chain answers first, so a test that stubs `$skin/skin.yaml` with its
	// own hook keeps its stub; only an answer on disk is re-pointed. With no
	// generated alias at all (a fresh clone) the chain cannot answer, and the
	// selected directory is the answer anyway.
	resolve(specifier, context, nextResolve) {
		if (!specifier.startsWith(ALIAS)) return nextResolve(specifier, context);
		const [path, query] = specifier.slice(ALIAS.length).split(/(?=\?)/);
		const selected = { url: pathToFileURL(resolvePath(skinDir(), path)).href + (query ?? '') };
		let resolved;
		try {
			resolved = nextResolve(specifier, context);
		} catch {
			return { ...selected, shortCircuit: true };
		}
		return resolved.url.startsWith('file:') ? { ...resolved, ...selected } : resolved;
	},
	load(url, context, nextLoad) {
		const at = new URL(url);
		if (at.protocol !== 'file:' || !at.pathname.endsWith(`/${SKIN_FILE}`)) {
			return nextLoad(url, context);
		}
		const file = fileURLToPath(new URL(at.pathname, at));
		const source =
			at.search === '?raw'
				? `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`
				: skinModuleSource(loadSkinDir(dirname(file)));
		return { format: 'module', source, shortCircuit: true };
	}
});
