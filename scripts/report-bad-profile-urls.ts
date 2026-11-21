// Lists stored url-field values the profile save check refuses: members in
// any status, and pending membership requests, which approval writes through
// that check. A member counts once however many of its values fail.
// Read-only: one READ ONLY transaction, no audit row, nothing rewritten.
// Usage: SKIN_DIR=skin/<community> pnpm report-bad-profile-urls
//        deploy/run.sh report-bad-profile-urls
import { DEFAULT_FIELD_SCHEMA } from '../src/lib/server/field-schema';
import { badProfileUrls } from '../src/lib/server/profile-url';
import { scriptPool } from './db';

type Row = {
	id: string;
	slug: string;
	data: Record<string, unknown> | null;
	private_data: Record<string, unknown> | null;
	linkedin: string | null;
};

const keys = DEFAULT_FIELD_SCHEMA.filter((f) => f.type === 'url').map((f) => f.key);
const linkedinKey = DEFAULT_FIELD_SCHEMA.find(
	(f) => f.type === 'url' && f.column === 'linkedin'
)?.key;

// Each stored copy is checked on its own. Merging them would let one hide
// another: the profile shows the typed column, the edit form reads the jsonb
// value, and a bad copy in either is a bad copy.
const sources: readonly [string, (r: Row) => Record<string, unknown>][] = [
	['data', (r) => r.data ?? {}],
	['private_data', (r) => r.private_data ?? {}],
	['column', (r) => (linkedinKey && r.linkedin != null ? { [linkedinKey]: r.linkedin } : {})]
];

function report(kind: string, rows: readonly Row[]) {
	const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
	const bad = sources.flatMap(([where, valuesOf]) =>
		badProfileUrls(
			rows.map((r) => ({ id: r.id, values: valuesOf(r) })),
			keys
		).map((b) => ({ ...b, where }))
	);
	const refused = new Set(bad.map((b) => b.memberId)).size;
	console.log(`${kind}: ${refused} of ${rows.length} refused, ${bad.length} bad values`);
	for (const b of bad)
		console.log(`  ${slugOf.get(b.memberId)}\t${b.memberId}\t${b.key}\t${b.where}\t${b.reason}`);
}

async function main() {
	const pool = scriptPool();
	const client = await pool.connect();
	try {
		await client.query('BEGIN READ ONLY');
		const members = await client.query<Row>(
			`SELECT m.id, g.slug, m.data, m.private_data, m.linkedin
			   FROM member m JOIN "group" g ON g.id = m.group_id`
		);
		const requests = await client.query<Row>(
			`SELECT r.id, g.slug, r.data, NULL::jsonb AS private_data, NULL::text AS linkedin
			   FROM access_request r JOIN "group" g ON g.id = r.group_id
			  WHERE r.status = 'pending'`
		);
		await client.query('ROLLBACK');
		report('member', members.rows);
		report('pending request', requests.rows);
	} finally {
		client.release();
		await pool.end();
	}
}

main().catch((e) => {
	console.error((e as Error).message);
	process.exit(1);
});
