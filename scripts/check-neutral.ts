// Core is published on its own, so no tracked file outside one community's skin
// may name that community, its host, its operator's domains or the Google
// integration the platform left. `pnpm check` runs this; it prints each file and
// line that does, and fails.
import { execFileSync } from 'node:child_process';
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Each term is joined from parts, so this file does not match its own list and
// needs no exception for itself.
const spell = (...parts: string[]) => parts.join('');
const CREDENTIAL = spell('GOOGLE', '_SA');

/** Matched as plain substrings, ignoring case. */
export const TERMS: readonly string[] = [
	spell('mozi', 'lla'),
	spell('moza', 'lum'),
	spell('cow', '.org'),
	spell('semi', 'colons'),
	spell('ident', '.agency'),
	spell('cyan', '.me'),
	spell('google', 'apis'),
	CREDENTIAL
];

/** Everything under this prefix belongs to the community, not to core. */
export const SKIN_PREFIX = `skin/${spell('moza', 'lums')}/`;

export interface Exception {
	path: string;
	term: string;
	reason: string;
}

export const EXCEPTIONS: readonly Exception[] = [
	{
		path: 'src/lib/server/redact.ts',
		term: CREDENTIAL,
		reason:
			'the log and audit redaction deny-list keeps the retired credential names, so a deployment upgraded with them still in its env file cannot leak the key into a log line'
	}
];

export interface Hit {
	path: string;
	line: number;
	term: string;
	text: string;
}

export function findHits(files: Iterable<{ path: string; text: string }>): Hit[] {
	const hits: Hit[] = [];
	for (const { path, text } of files) {
		if (path.startsWith(SKIN_PREFIX)) continue;
		text.split('\n').forEach((line, i) => {
			const lower = line.toLowerCase();
			for (const term of TERMS) {
				if (!lower.includes(term.toLowerCase())) continue;
				if (EXCEPTIONS.some((e) => e.path === path && e.term === term)) continue;
				hits.push({ path, line: i + 1, term, text: line.trim() });
			}
		});
	}
	return hits;
}

export const formatHit = (h: Hit) => `${h.path}:${h.line}: [${h.term}] ${h.text.slice(0, 160)}`;

const SUBMODULE = '160000';

/** Each tracked path's staged blobs, read from the object store, never from disk. */
function stagedBlobs(root: string): Map<string, string[]> {
	const entries = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8' })
		.split('\0')
		.filter(Boolean)
		.map((entry) => {
			const [meta, path] = [entry.slice(0, entry.indexOf('\t')), entry.slice(entry.indexOf('\t') + 1)];
			const [mode, oid] = meta.split(' ');
			return { mode, oid, path };
		})
		// A submodule's entry names a commit in another repository, not a blob.
		.filter((e) => e.mode !== SUBMODULE);
	const blobs = new Map<string, string[]>();
	if (!entries.length) return blobs;
	const out = execFileSync('git', ['cat-file', '--batch'], {
		cwd: root,
		input: entries.map((e) => e.oid).join('\n') + '\n',
		maxBuffer: 1 << 30
	});
	let at = 0;
	for (const { oid, path } of entries) {
		const eol = out.indexOf(0x0a, at);
		const header = out.subarray(at, eol).toString('utf8');
		const [gotOid, type, size] = header.split(' ');
		if (gotOid !== oid || type !== 'blob') {
			throw new Error(`check-neutral: git cannot read the staged blob for ${path} (${header})`);
		}
		const body = out.subarray(eol + 1, eol + 1 + Number(size));
		at = eol + 1 + Number(size) + 1;
		blobs.set(path, [...(blobs.get(path) ?? []), body.toString('utf8')]);
	}
	return blobs;
}

/** Whether every parent of a tracked path is a real directory, never a link. */
function parentsAreDirectories(root: string, parts: readonly string[]): boolean {
	let dir = root;
	for (const part of parts.slice(0, -1)) {
		dir = `${dir}/${part}`;
		if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
	}
	return true;
}

/**
 * The working-tree text at a tracked path, where git would stage one. Git never
 * stages through a symlinked directory, so a link in any parent component ends
 * the walk: the path has no working-tree copy and only its staged blob counts.
 * The leaf is checked with lstat, so a symlink's blob is its link text and its
 * target is never opened. Anything else at the path (a directory, a FIFO) is
 * read as nothing. The file is opened without following a link, then the
 * parents are checked again and the open inode must still be the one at the
 * path, so swapping a directory for a link mid-read cannot pull outside bytes
 * into a diagnostic.
 */
function workingText(root: string, path: string): string | undefined {
	const parts = path.split('/');
	if (!parentsAreDirectories(root, parts)) return undefined;
	const full = `${root}/${path}`;
	const stat = lstatSync(full, { throwIfNoEntry: false });
	if (stat?.isSymbolicLink()) {
		const text = readlinkSync(full, 'utf8');
		return parentsAreDirectories(root, parts) ? text : undefined;
	}
	if (!stat?.isFile()) return undefined;
	let fd: number;
	try {
		fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
	try {
		const opened = fstatSync(fd);
		const now = lstatSync(full, { throwIfNoEntry: false });
		if (
			!opened.isFile() ||
			!parentsAreDirectories(root, parts) ||
			now?.dev !== opened.dev ||
			now?.ino !== opened.ino
		) {
			return undefined;
		}
		return readFileSync(fd).toString('utf8');
	} finally {
		closeSync(fd);
	}
}

/**
 * Every tracked path's staged blob, which is what the next commit and its
 * export ship whether or not the path exists on disk (a sparse checkout, a
 * deletion not yet staged), plus the working-tree copy where it differs, so an
 * unstaged edit fails before it is committed. Binary content is decoded too:
 * the decoder replaces invalid bytes but never consumes an ASCII byte, so
 * every term still matches on its line.
 */
export function* trackedFiles(root: string): Generator<{ path: string; text: string }> {
	const real = realpathSync(root);
	for (const [path, staged] of stagedBlobs(root)) {
		for (const text of new Set(staged)) yield { path, text };
		const working = workingText(real, path);
		if (working !== undefined && !staged.includes(working)) yield { path, text: working };
	}
}

/**
 * Every file under a directory that is not a repository, such as a tree
 * `scripts/split-export.sh` wrote. A link yields its link text and is never
 * followed, the way a tracked link is read.
 */
export function* filesUnder(root: string, dir = ''): Generator<{ path: string; text: string }> {
	for (const entry of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
		const path = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) yield* filesUnder(root, path);
		else if (entry.isSymbolicLink()) yield { path, text: readlinkSync(`${root}/${path}`, 'utf8') };
		else if (entry.isFile()) yield { path, text: readFileSync(`${root}/${path}`).toString('utf8') };
	}
}

// The script's own URL is its resolved path, so argv[1] is resolved too: run
// through a linked directory (macOS's /var is one), a plain comparison never
// matches and the check exits 0 having checked nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const [flag, tree] = process.argv.slice(2);
	if (flag !== undefined && (flag !== '--tree' || !tree)) {
		console.error('usage: check-neutral.ts [--tree <exported-directory>]');
		process.exit(2);
	}
	const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
	const hits = findHits(tree ? filesUnder(tree) : trackedFiles(root));
	if (hits.length) {
		console.error(
			`[check-neutral] ${hits.length} line(s) outside ${SKIN_PREFIX} name the community or the retired integration:`
		);
		for (const h of hits) console.error(`  ${formatHit(h)}`);
		console.error(
			`Move site values under ${SKIN_PREFIX}, reword, or add an entry with its reason to EXCEPTIONS in scripts/check-neutral.ts.`
		);
		process.exit(1);
	}
	console.log(
		tree
			? `neutral: no file in ${tree} names the community`
			: `neutral: no tracked file outside ${SKIN_PREFIX} names the community`
	);
}
