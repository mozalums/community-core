// The admin CSV export without a browser session: the same columns, escaping
// and audit row as /admin/export, over the script pool.
// Usage: pnpm export-members <slug> [--private] [--removed] [--out <file>]
//        deploy/run.sh export-members <slug> [--private] > roster.csv
import { writeFileSync } from 'node:fs';
import { auditIn } from '../src/lib/server/audit-core';
import {
	exportAuditEntry,
	exportFilename,
	loadExportMembers,
	memberCsv,
	type ExportOptions
} from '../src/lib/server/member-export';
import { scriptPool } from './db';

const USAGE = 'usage: export-members <slug> [--private] [--removed] [--out <file>]';

function parseArgs(argv: string[]): { slug: string; opts: ExportOptions; out: string | null } {
	let slug: string | null = null;
	let out: string | null = null;
	const opts: ExportOptions = { includePrivate: false, includeRemoved: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--private') opts.includePrivate = true;
		else if (a === '--removed') opts.includeRemoved = true;
		else if (a === '--out' && argv[i + 1]) out = argv[++i];
		else if (!a.startsWith('-') && slug === null) slug = a;
		else throw new Error(`unexpected argument "${a}"\n${USAGE}`);
	}
	if (!slug) throw new Error(USAGE);
	return { slug, opts, out };
}

async function main() {
	const { slug, opts, out } = parseArgs(process.argv.slice(2));
	// A roster dumped to a terminal lands in scrollback and in whatever records
	// the session. Refusing costs one redirect.
	if (!out && process.stdout.isTTY) {
		throw new Error(`stdout is a terminal; redirect it to a file or pass --out <file>\n${USAGE}`);
	}

	const pool = scriptPool();
	const client = await pool.connect();
	let body: string;
	let rows: number;
	try {
		const { rows: groups } = await client.query<{ id: string; slug: string }>(
			`SELECT id, slug FROM "group" WHERE slug = $1 AND status = 'active'`,
			[slug]
		);
		if (!groups[0]) throw new Error(`no active group with slug "${slug}"`);
		const group = groups[0];

		await client.query('BEGIN');
		const members = await loadExportMembers(client, group.id, opts);
		if (opts.includePrivate) {
			// No session at a terminal, so the actor is the channel.
			await auditIn(
				client,
				exportAuditEntry(group, opts, members.length, {
					actorSubject: 'cli:export-members',
					actorEmail: null
				})
			);
		}
		body = memberCsv(members, opts);
		await client.query('COMMIT');
		rows = members.length;
	} catch (e) {
		await client.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		client.release();
		await pool.end();
	}

	// 0600 because a private export is the whole directory's addresses and
	// phone numbers, and `wx` because overwriting yesterday's copy by accident is
	// a lost backup.
	if (out) writeFileSync(out, body, { mode: 0o600, flag: 'wx' });
	else process.stdout.write(body);
	console.error(
		`export-members: ${rows} member(s) from ${slug}` +
			`${opts.includePrivate ? ', private fields included (audited)' : ''}` +
			` > ${out ?? `stdout (suggested name ${exportFilename(slug, opts, new Date())})`}`
	);
}

main().catch((e) => {
	console.error(`[export-members] ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
