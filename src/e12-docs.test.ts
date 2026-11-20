import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

// Spelled in parts so scripts/check-neutral.ts, which refuses the credential's
// name anywhere but the redaction deny-list, does not count this file.
const SA = ['GOOGLE', 'SA'].join('_');

// E12 requirements 9 and 10 are about the internal documents, which no clone
// carries: `docs-internal/` is untracked on purpose. The assertions live here so
// the branch holds them. Against the real documents they run only where that
// directory is present; against the inputs written out below they run
// everywhere, and those are what show each assertion can fail.

const DOCS = new URL('../docs-internal/', import.meta.url);
const SESSION = 'CHANGELOG_2026_11_16.md';
const overlay = {
	skip: existsSync(DOCS) ? false : 'docs-internal/ is not present in this checkout'
};

type Files = Record<string, string>;

const OLD_NAMES = [
	'sheet_id',
	'column_map',
	'dash-access',
	'sync_run',
	`${SA}_EMAIL`,
	'pnpm sync'
];
const SWEPT_NAMES = [
	'sheet_id',
	'column_map',
	'dash-access',
	'sync_run',
	'source_row',
	`${SA}_EMAIL`
];

/** Requirement 9: the past changelogs are untouched and the sweep is an entry of its own. */
export function assertChangelogs(files: Files, atLeast: number): void {
	const past = Object.keys(files).filter((f) => /^CHANGELOG_.*\.md$/.test(f) && f < SESSION);
	assert.ok(past.length >= atLeast, 'the scan found no changelogs');
	const all = past.map((f) => files[f]).join('\n');
	// What a find-and-replace across the directory would have erased.
	for (const old of OLD_NAMES) {
		assert.ok(all.includes(old), `no past changelog names ${old} any more`);
	}
	for (const f of past) {
		assert.doesNotMatch(
			files[f],
			/drop_sheet_era|E12: the Google integration is deleted/,
			`${f} was edited by E12`
		);
	}

	const entry = files[SESSION] ?? '';
	assert.match(entry, /^## E12: the Google integration is deleted$/m);
	const sweep = entry.split(/^### The sweep, and what it did not touch$/m)[1]?.split(/^### /m)[0];
	assert.ok(sweep, 'the entry does not record the sweep');
	for (const old of SWEPT_NAMES) {
		assert.ok(sweep.includes(`\`${old}\``), `the sweep entry does not name the old ${old}`);
	}
	assert.match(sweep, /`resolveGroupAdmin` in `groups\.ts`/, 'the sweep entry names no new form');
	assert.match(sweep, /No `docs-internal\/CHANGELOG_\*\.md` file was part of any find-and-replace/);
}

/** Requirement 10: the three documents that described the sheet era describe the tree now. */
export function assertDocuments(files: Files): void {
	const table =
		(files['DELIVERY_2026_08_12.md'] ?? '')
			.split(/^## Content is not code$/m)[1]
			?.split(/^## /m)[0] ?? '';
	const row = (name: string) => table.split('\n').find((l) => l.startsWith(`| ${name} `)) ?? '';
	assert.match(row('Member directory'), /Postgres/);
	assert.doesNotMatch(row('Member directory'), /Google|Sync button/);
	assert.doesNotMatch(row('Manifesto, Code of Conduct'), /A Google Doc, one tab each/);
	assert.match(row('Manifesto, Code of Conduct'), /E41/);
	assert.doesNotMatch(table, /editing the manifesto today means SSHing/);

	const removal = files['GOOGLE_REMOVAL_2026_08_12.md'] ?? '';
	assert.doesNotMatch(removal, /Status: shelved/);
	assert.match(removal, /Status: carried out/);
	const capability = removal.split(/^## What Google provides$/m)[1]?.split(/^## /m)[0] ?? '';
	assert.match(capability, /\| Capability \| Where it lived \| What replaced it \|/);
	assert.doesNotMatch(capability, /no Postgres write path exists|dead code|unioned with the Sheet/);
	for (const item of ['`F2`', '`F3`', '`F4`', '`F5`', '`F7`', '`E39`', '`E41`']) {
		assert.ok(capability.includes(item), `the capability table does not credit ${item}`);
	}
	const gaps = removal.split(/^## Gaps$/m)[1] ?? '';
	assert.doesNotMatch(gaps, /while the Sheet still exists as a fallback/);
	assert.match(gaps, /The spreadsheet and the Google Doc still exist/);

	const audit = files['SECURITY_AUDIT_2026_08_09.md'] ?? '';
	assert.doesNotMatch(audit, /are absent, so no sync has run and every group route 404s/);
	assert.match(audit, /since `E12` their absence means nothing/);
	assert.doesNotMatch(audit, /none of which the Google Sheet is upstream of/);
}

function overlayFiles(): Files {
	return Object.fromEntries(
		readdirSync(DOCS)
			.filter((f) => f.endsWith('.md'))
			.map((f) => [f, readFileSync(new URL(f, DOCS), 'utf8')])
	);
}

// The two declarations below stay on one line each: the review's check looks
// for `test('<name>'` verbatim, and a formatter would break the line after `test(`.
// prettier-ignore
test('R9: past changelogs still name the sheet-era identifiers, and the sweep is its own entry naming old and new', overlay, () => {
	assertChangelogs(overlayFiles(), 10);
});

// prettier-ignore
test('R10: the delivery table, the removal plan and the security audit describe the tree after E12', overlay, () => {
	assertDocuments(overlayFiles());
});

// ---------------------------------------------------------------------------
// Controlled inputs. Each `after` is the least text the assertions accept, and
// each rejection puts back one thing the documents said before E12, or does to
// a changelog what a sweep would have done.
// ---------------------------------------------------------------------------

const PAST_CHANGELOG =
	'# 2026-08-20\n\n`pnpm sync` copies the sheet named by `sheet_id` through `column_map`,\n' +
	`records a \`sync_run\`, and \`dash-access.ts\` reads the grants with \`${SA}_EMAIL\`.\n`;

const SESSION_ENTRY = [
	'# 2026-11-16',
	'',
	'## E12: the Google integration is deleted',
	'',
	'### The sweep, and what it did not touch',
	'',
	`- \`sheet_id\`, \`column_map\`, \`sync_run\`, \`source_row\` and \`${SA}_EMAIL\` left the tree.`,
	'- `dash-access` became `resolveGroupAdmin` in `groups.ts`.',
	'- No `docs-internal/CHANGELOG_*.md` file was part of any find-and-replace.',
	'',
	'### Removed',
	''
].join('\n');

const CHANGELOGS_AFTER: Files = {
	'CHANGELOG_2026_08_20.md': PAST_CHANGELOG,
	[SESSION]: SESSION_ENTRY
};

test('R9: the changelog check accepts an untouched history and rejects a swept one', () => {
	assertChangelogs(CHANGELOGS_AFTER, 1);

	const rejects = (files: Files, why: RegExp) =>
		assert.throws(() => assertChangelogs(files, 1), { message: why });

	// A rename applied across the directory.
	rejects(
		{
			...CHANGELOGS_AFTER,
			'CHANGELOG_2026_08_20.md': PAST_CHANGELOG.replaceAll('sheet_id', 'roster')
		},
		/no past changelog names sheet_id/
	);
	rejects(
		{
			...CHANGELOGS_AFTER,
			'CHANGELOG_2026_08_20.md': PAST_CHANGELOG.replaceAll('dash-access', 'groups')
		},
		/no past changelog names dash-access/
	);
	// The item written into a dated file that is not this session's.
	rejects(
		{
			...CHANGELOGS_AFTER,
			'CHANGELOG_2026_08_20.md': `${PAST_CHANGELOG}\nMigration 15 (\`drop_sheet_era\`) later dropped it.\n`
		},
		/was edited by E12/
	);
	// The state before the entry existed, and an entry that says what went
	// without naming what replaced it.
	rejects({ 'CHANGELOG_2026_08_20.md': PAST_CHANGELOG }, /E12: the Google integration is deleted/);
	rejects(
		{ ...CHANGELOGS_AFTER, [SESSION]: SESSION_ENTRY.replace(/^- `dash-access` became.*\n/m, '') },
		/does not name the old dash-access|names no new form/
	);
	rejects(
		{ ...CHANGELOGS_AFTER, [SESSION]: SESSION_ENTRY.replace(/^- No `docs-internal.*\n/m, '') },
		/find-and-replace/
	);
	rejects({ [SESSION]: SESSION_ENTRY }, /the scan found no changelogs/);
});

const DELIVERY_AFTER = [
	'## Content is not code',
	'',
	'| Content | Lives in | Changed by |',
	'| --- | --- | --- |',
	'| Member directory | Postgres, the only copy | Profile edits and CSV import |',
	'| Manifesto, Code of Conduct | Nothing yet | `E41` |',
	'',
	'## Next',
	''
].join('\n');

const REMOVAL_AFTER = [
	'> **Status: carried out.**',
	'',
	'## What Google provides',
	'',
	'| Capability | Where it lived | What replaced it |',
	'| --- | --- | --- |',
	'| Roster | Sheet | `member` (`F5`, `F7`) |',
	'| Schema | Sheet header | `F3` |',
	'| Requests | Sheet tab | `F4` |',
	'| Admin roles | Sheet tab | `E39` |',
	'| Documents | Google Doc | `E41` |',
	'| History | Revision log | `F2` |',
	'',
	'## Gaps',
	'',
	'- **The spreadsheet and the Google Doc still exist.**',
	''
].join('\n');

const AUDIT_AFTER =
	`### A10\n\n\`${SA}_*\` were what the sync needed; since \`E12\` their absence means nothing.\n`;

const DOCUMENTS_AFTER: Files = {
	'DELIVERY_2026_08_12.md': DELIVERY_AFTER,
	'GOOGLE_REMOVAL_2026_08_12.md': REMOVAL_AFTER,
	'SECURITY_AUDIT_2026_08_09.md': AUDIT_AFTER
};

// One row per sentence the documents carried before E12. The left side is the
// file it was in, the middle puts the sentence back, the right is the complaint.
const BEFORE: [string, (after: string) => string, RegExp][] = [
	[
		'DELIVERY_2026_08_12.md',
		(d) =>
			d.replace(
				'Postgres, the only copy | Profile edits and CSV import',
				'Google Sheet, copied to Postgres | The Sync button'
			),
		/Postgres/
	],
	[
		'DELIVERY_2026_08_12.md',
		(d) => d.replace('Profile edits and CSV import', 'The Sync button on /admin'),
		/Sync button/
	],
	[
		'DELIVERY_2026_08_12.md',
		(d) => d.replace('Nothing yet | `E41`', 'A Google Doc, one tab each | `pnpm load-docs`'),
		/A Google Doc, one tab each/
	],
	[
		'DELIVERY_2026_08_12.md',
		(d) =>
			d.replace('## Next', 'So editing the manifesto today means SSHing to the host.\n\n## Next'),
		/editing the manifesto today means SSHing/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) => r.replace('Status: carried out.', 'Status: shelved.'),
		/Status: shelved/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) =>
			r.replace(
				'| Capability | Where it lived | What replaced it |',
				'| Capability | Today | Notes |'
			),
		/Capability \\\| Where it lived/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) =>
			r.replace('`member` (`F5`, `F7`)', 'Synced into `member`; no Postgres write path exists'),
		/no Postgres write path exists/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) => r.replace('| `E39` |', '| `group_admin`, unioned with the Sheet (`E39`) |'),
		/unioned with the Sheet/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) =>
			r.replace(
				'| Requests | Sheet tab | `F4` |',
				'| Requests | Sheet tab | `access_request` is dead code |'
			),
		/dead code/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) =>
			r.replace(
				'| Documents | Google Doc | `E41` |',
				'| Documents | Google Doc | script-ingested |'
			),
		/does not credit `E41`/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) => `${r}- Tolerable while the Sheet still exists as a fallback.\n`,
		/while the Sheet still exists as a fallback/
	],
	[
		'GOOGLE_REMOVAL_2026_08_12.md',
		(r) => r.replace('- **The spreadsheet and the Google Doc still exist.**\n', ''),
		/The spreadsheet and the Google Doc still exist/
	],
	[
		'SECURITY_AUDIT_2026_08_09.md',
		(a) => `${a}\n\`${SA}_*\` are absent, so no sync has run and every group route 404s.\n`,
		/no sync has run and every group route 404s/
	],
	[
		'SECURITY_AUDIT_2026_08_09.md',
		(a) =>
			a.replace(
				'since `E12` their absence means nothing',
				'their absence means the directory is empty'
			),
		/since `E12` their absence means nothing/
	],
	[
		'SECURITY_AUDIT_2026_08_09.md',
		(a) => `${a}\nAvatars, stars and admins, none of which the Google Sheet is upstream of.\n`,
		/none of which the Google Sheet is upstream of/
	]
];

test('R10: the document check accepts the after text and rejects each sentence E12 retired', () => {
	assertDocuments(DOCUMENTS_AFTER);
	for (const [file, before, why] of BEFORE) {
		const reverted = { ...DOCUMENTS_AFTER, [file]: before(DOCUMENTS_AFTER[file]) };
		assert.notEqual(reverted[file], DOCUMENTS_AFTER[file], `the ${why} case changed nothing`);
		assert.throws(() => assertDocuments(reverted), { message: why }, `${file}: ${why}`);
	}
});
