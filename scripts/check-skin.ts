// Validates the skin at the root of a site's repository, the check a skin
// repository's CI runs before it builds. Prints the skin's id on success.
//
//   node --import tsx scripts/check-skin.ts <site-root>
//
// The loader refuses any code file or link anywhere under the directory it is
// given, and a site's root also holds core (as a submodule) and the site's own
// .github scripts. So the four entries a skin consists of are copied out first,
// the same four the Dockerfile copies from the `skin` build context, and the
// loader judges exactly what the image would compile in.
import { cpSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkinDir, type LoadedSkin } from '../src/lib/skin/load';
import { SkinError } from '../src/lib/skin/schema';

export const SKIN_ENTRIES: readonly string[] = ['skin.yaml', 'theme.css', 'copy', 'static'];

export function checkSkinRoot(root: string): LoadedSkin {
	const stage = mkdtempSync(join(tmpdir(), 'check-skin-'));
	try {
		for (const name of SKIN_ENTRIES) {
			const from = join(root, name);
			if (!lstatSync(from, { throwIfNoEntry: false })) continue;
			// Links are copied as links, so the loader still refuses them.
			cpSync(from, join(stage, name), { recursive: true, verbatimSymlinks: true });
		}
		return loadSkinDir(stage);
	} catch (e) {
		if (!(e instanceof SkinError)) throw e;
		throw new SkinError(e.file.replace(stage, root), e.issues);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = process.argv[2];
	if (!root || process.argv.length > 3) {
		console.error('usage: check-skin.ts <site-root>');
		process.exit(2);
	}
	try {
		console.log(checkSkinRoot(resolve(root)).skin.id);
	} catch (e) {
		if (!(e instanceof SkinError)) throw e;
		console.error(e.message);
		process.exit(1);
	}
}
