// The roster import without a browser: the same parser, diff and writes as
// /admin/import, in one transaction under the same lock, over the script pool.
// It exists for what the browser refuses, removing more than half the active
// roster, and so every removal has to be confirmed by count.
// Usage: pnpm import-members <slug> <file|-> [--replace] [--apply] [--confirm-removals <n>]
//        deploy/run.sh import-members <slug> - --replace --apply --confirm-removals 412 < roster.csv
// `-` reads the file from stdin, which is how it reaches the container run.sh
// starts: only scripts/ is mounted there.
import { readFileSync } from 'node:fs';
import { recordPrivateValuesFrom } from '../src/lib/server/audit-core';
import {
	MAX_IMPORT_BYTES,
	decodeUpload,
	previewView,
	type ImportMode
} from '../src/lib/server/import-core';
import { runImport } from '../src/lib/server/member-import';
import { scriptPool } from './db';

const USAGE =
	'usage: import-members <slug> <file|-> [--replace] [--apply] [--confirm-removals <n>]\n' +
	'  Without --apply it prints what would change and changes nothing.';

type ImportArgs = {
	slug: string;
	file: string;
	mode: ImportMode;
	apply: boolean;
	confirmRemovals: number | null;
};

function parseArgs(argv: string[]): ImportArgs {
	const pos: string[] = [];
	let mode: ImportMode = 'merge';
	let apply = false;
	let confirmRemovals: number | null = null;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--replace') mode = 'replace';
		else if (a === '--apply') apply = true;
		else if (a === '--confirm-removals' && /^\d+$/.test(argv[i + 1] ?? '')) {
			confirmRemovals = Number(argv[++i]);
		} else if ((a === '-' || !a.startsWith('-')) && pos.length < 2) pos.push(a);
		else throw new Error(`unexpected argument "${a}"\n${USAGE}`);
	}
	if (pos.length !== 2) throw new Error(USAGE);
	return { slug: pos[0], file: pos[1], mode, apply, confirmRemovals };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	// Eight times the browser's cap: this path exists for the large case, but a
	// file that size is still a mistake rather than a roster.
	const bytes = readFileSync(args.file === '-' ? 0 : args.file);
	if (bytes.length > MAX_IMPORT_BYTES * 8) {
		throw new Error(`the file is larger than ${MAX_IMPORT_BYTES * 8} bytes; refusing it`);
	}
	const text = decodeUpload(bytes);

	const pool = scriptPool();
	const client = await pool.connect();
	try {
		const { rows: groups } = await client.query<{ id: string; slug: string }>(
			`SELECT id, slug FROM "group" WHERE slug = $1 AND status = 'active'`,
			[args.slug]
		);
		if (!groups[0]) throw new Error(`no active group with slug "${args.slug}"`);

		await client.query('BEGIN');
		const out = await runImport(
			client,
			groups[0],
			{ actorSubject: 'cli:import-members', actorEmail: null },
			{
				text,
				mode: args.mode,
				apply: args.apply,
				confirmRemovals: args.confirmRemovals,
				recordPrivateValues: recordPrivateValuesFrom(process.env)
			}
		);
		for (const w of out.warnings) console.error(`warning: ${w}`);
		if (!out.ok) {
			await client.query('ROLLBACK');
			for (const e of out.errors) console.error(`error: ${e}`);
			process.exitCode = 1;
			return;
		}
		const v = previewView(out.diff);
		for (const r of v.removed) console.error(`remove  ${r.email} (${r.why})`);
		for (const c of v.changed)
			console.error(`change  ${c.email}: ${c.fields.map((f) => f.label).join(', ')}`);
		for (const a of v.added) console.error(`add     ${a.email}`);
		const counts = `${v.counts.added} added, ${v.counts.changed} changed, ${v.counts.removed} removed, ${v.counts.unchanged} unchanged`;
		if (out.applied) {
			await client.query('COMMIT');
			console.error(
				`import-members: ${args.mode} applied to ${args.slug}: ${counts} (run ${out.runId})`
			);
		} else {
			await client.query('ROLLBACK');
			console.error(
				`import-members: ${args.mode} dry run for ${args.slug}: ${counts}. Nothing changed; pass --apply to apply.`
			);
		}
	} catch (e) {
		await client.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		client.release();
		await pool.end();
	}
}

main().catch((e) => {
	console.error(`[import-members] ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
