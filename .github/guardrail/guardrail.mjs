// Decides whether a pull request against this repository may merge, and fails
// the workflow that runs it when it may not. GitHub's free plan enforces no
// branch protection and no CODEOWNERS on a private repository, so this status
// is the only review requirement there is.
//
// The rule: a pull request opened by a login in MAINTAINERS passes; any other
// needs an approving review from a maintainer on its current head commit. A
// maintainer can already push to main directly, so holding their own pull
// request for a second approval protects nothing, and with one maintainer it
// would block every change. The failure names any protected path the change touches:
// anything under deploy/ or .github/, .gitmodules, MAINTAINERS, and every
// submodule path (the core pin). A rename counts at both of its paths.
//
// MAINTAINERS and .gitmodules are read from the base branch through the API,
// never from the pull request, so a pull request cannot add its author to the
// list it is judged by. The workflow runs this file from a checkout of the base
// branch for the same reason.
//
// Runs on the runner's own Node with no dependencies: `node guardrail.mjs`,
// with GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH set by Actions.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PROTECTED_DIRECTORIES = ['deploy/', '.github/'];
export const PROTECTED_FILES = ['.gitmodules', 'MAINTAINERS'];

/**
 * @typedef {{ filename: string, previous_filename?: string }} ChangedFile
 * @typedef {{ user: { login: string } | null, state: string, commit_id: string }} Review
 * @typedef {{ pass: boolean, reason: string }} Decision
 * @typedef {(path: string, options?: { raw?: boolean }) => Promise<any>} Get
 *   Resolves to the parsed JSON body, the text body when `raw`, or null on 404.
 */

/** One login per line; `#` starts a comment and a leading `@` is optional. */
export function parseMaintainers(/** @type {string | null} */ text) {
	return (text ?? '')
		.split('\n')
		.map((line) => line.replace(/#.*/, '').trim().replace(/^@/, '').toLowerCase())
		.filter(Boolean);
}

/** The `path =` of every submodule a .gitmodules declares. */
export function submodulePaths(/** @type {string | null} */ text) {
	return [...(text ?? '').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

/**
 * Every changed path the rule protects.
 * @param {readonly ChangedFile[]} files
 * @param {readonly string[]} submodules
 */
export function protectedChanges(files, submodules) {
	const paths = files.flatMap((f) => [f.filename, f.previous_filename ?? []].flat());
	const guarded = paths.filter(
		(p) =>
			PROTECTED_DIRECTORIES.some((dir) => p.startsWith(dir)) ||
			PROTECTED_FILES.includes(p) ||
			submodules.includes(p)
	);
	return [...new Set(guarded)].sort();
}

/**
 * Logins whose latest review that decides anything is an approval of `headSha`.
 * A comment decides nothing; a later request for changes or a dismissal
 * withdraws an approval, and an approval of an older commit does not carry.
 * @param {readonly Review[]} reviews in the order GitHub returns them, oldest first
 * @param {string} headSha
 */
export function approvalsOnHead(reviews, headSha) {
	/** @type {Map<string, Review>} */
	const latest = new Map();
	for (const r of reviews) {
		if (!r.user || r.state === 'COMMENTED' || r.state === 'PENDING') continue;
		latest.set(r.user.login.toLowerCase(), r);
	}
	return [...latest]
		.filter(([, r]) => r.state === 'APPROVED' && r.commit_id === headSha)
		.map(([login]) => login);
}

/**
 * @param {{
 *   author: string,
 *   headSha: string,
 *   files: readonly ChangedFile[],
 *   reviews: readonly Review[],
 *   maintainers: readonly string[],
 *   submodules: readonly string[]
 * }} input
 * @returns {Decision}
 */
export function decide({ author, headSha, files, reviews, maintainers, submodules }) {
	const owners = new Set(maintainers.map((m) => m.toLowerCase()));
	const by = author.toLowerCase();
	const head = headSha.slice(0, 7);
	if (!owners.size) {
		return {
			pass: false,
			reason: 'MAINTAINERS on the base branch lists nobody, so nobody can approve'
		};
	}
	if (owners.has(by)) {
		return { pass: true, reason: `opened by maintainer ${author}, on head ${head}` };
	}
	const approvers = approvalsOnHead(reviews, headSha).filter((l) => owners.has(l));
	if (approvers.length) {
		return { pass: true, reason: `approved on ${head} by maintainer ${approvers.join(', ')}` };
	}
	const guarded = protectedChanges(files, submodules);
	const stale = reviews
		.filter((r) => r.state === 'APPROVED' && r.user && owners.has(r.user.login.toLowerCase()))
		.filter((r) => r.commit_id !== headSha);
	const why = guarded.length
		? `${author} is not in MAINTAINERS and changes ${guarded.join(', ')}, so a maintainer has to approve`
		: `${author} is not in MAINTAINERS, so a maintainer has to approve`;
	const note = stale.length
		? '; an approval of an earlier commit does not count, re-review the head'
		: '';
	return { pass: false, reason: `${why}, on head ${head}${note}` };
}

/**
 * Every item of a paginated list endpoint.
 * @param {Get} get
 * @param {string} path
 */
async function every(get, path) {
	const all = [];
	for (let page = 1; ; page++) {
		const batch = (await get(`${path}?per_page=100&page=${page}`)) ?? [];
		all.push(...batch);
		if (batch.length < 100) return all;
	}
}

/**
 * Reads the pull request through `get` and decides it.
 * @param {{ get: Get, repo: string, number: number }} input
 * @returns {Promise<Decision>}
 */
export async function run({ get, repo, number }) {
	const at = `/repos/${repo}`;
	const pr = await get(`${at}/pulls/${number}`);
	if (!pr) throw new Error(`pull request ${repo}#${number} not found`);
	const files = await every(get, `${at}/pulls/${number}/files`);
	// The files endpoint stops at 3000 entries. A protected path past that point
	// would go unseen, so a list shorter than GitHub's count fails closed.
	if (files.length < pr.changed_files) {
		return {
			pass: false,
			reason: `GitHub listed ${files.length} of ${pr.changed_files} changed files; split the pull request`
		};
	}
	const base = encodeURIComponent(pr.base.ref);
	const [maintainers, gitmodules, reviews] = await Promise.all([
		get(`${at}/contents/MAINTAINERS?ref=${base}`, { raw: true }),
		get(`${at}/contents/.gitmodules?ref=${base}`, { raw: true }),
		every(get, `${at}/pulls/${number}/reviews`)
	]);
	return decide({
		author: pr.user.login,
		headSha: pr.head.sha,
		files,
		reviews,
		maintainers: parseMaintainers(maintainers),
		submodules: submodulePaths(gitmodules)
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;
	const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
	if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH) {
		console.error('guardrail: GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_EVENT_PATH must be set');
		process.exit(2);
	}
	const number = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8')).pull_request?.number;
	if (!number) {
		console.error('guardrail: the event carries no pull request');
		process.exit(2);
	}
	/** @type {Get} */
	const get = async (path, { raw = false } = {}) => {
		const res = await fetch(`${api}${path}`, {
			headers: {
				authorization: `Bearer ${GITHUB_TOKEN}`,
				accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28'
			}
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}: ${await res.text()}`);
		return raw ? res.text() : res.json();
	};
	const decision = await run({ get, repo: GITHUB_REPOSITORY, number });
	if (decision.pass) {
		console.log(`guardrail: pass: ${decision.reason}`);
	} else {
		console.log(`::error title=Maintainer approval required::${decision.reason}`);
		process.exitCode = 1;
	}
}
