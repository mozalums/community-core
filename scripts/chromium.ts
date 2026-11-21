// The browser the component tests drive. A host may have a Chrome of its own; any
// other gets the Chromium build pinned by playwright-core, downloaded on first use
// through playwright-core's own installer, so the revision always matches the
// protocol client in the lockfile.
//
// Loaded with `--import`, it also redirects a launch whose `executablePath` names
// a browser this host lacks: the E52 review scripts are committed as the review
// wrote them, pointing at a macOS Chrome, and run unchanged on every other host.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

const require = createRequire(import.meta.url);

/** A browser binary on this host, installing playwright-core's Chromium if none exists. */
export function chromiumExecutable(preferred?: string): string {
	if (preferred && existsSync(preferred)) return preferred;
	const pinned = chromium.executablePath();
	if (existsSync(pinned)) return pinned;
	const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
	const install = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
	if (install.status !== 0 || !existsSync(pinned))
		throw new Error(
			`playwright-core could not install Chromium at ${pinned}; run: node ${cli} install chromium`
		);
	return pinned;
}

const launch = chromium.launch.bind(chromium);
chromium.launch = (options: LaunchOptions = {}): Promise<Browser> =>
	launch({ ...options, executablePath: chromiumExecutable(options.executablePath) });

export const launchChromium = (): Promise<Browser> => chromium.launch({ headless: true });
