// Lists stored url-field values the profile save check refuses, and every
// LinkedIn value migration 22 could not turn into a link: members in any
// status, and pending membership requests, which approval writes through that
// check. A member counts once however many of its values fail.
// Read-only: one READ ONLY transaction, no audit row, nothing rewritten.
// Usage: SKIN_DIR=skin/<community> pnpm report-bad-profile-urls
//        deploy/run.sh report-bad-profile-urls
import { DEFAULT_FIELD_SCHEMA } from '../src/lib/server/field-schema';
import { badProfileUrls } from '../src/lib/server/profile-url';
import { UNCONVERTED_LINKEDIN_KEY } from '../src/lib/server/migrations';
import { scriptPool } from './db';

type Row = {
	id: string;
	slug: string;
	data: Record<string, unknown> | null;
	private_data: Record<string, unknown> | null;
};

const keys = DEFAULT_FIELD_SCHEMA.filter((f) => f.type === 'url').map((f) => f.key);

// Each stored copy is checked on its own, so one bag cannot hide the other.
const sources: readonly [string, (r: Row) => Record<string, unknown>][] = [
	['data', (r) => r.data ?? {}],
	['private_data', (r) => r.private_data ?? {}]
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
	// An admin fixes each by adding the member's LinkedIn link and clearing
	// the kept value; the value is printed so the fix needs no second lookup.
	const kept = rows.flatMap((r) =>
		sources.flatMap(([where, valuesOf]) => {
			const values = valuesOf(r);
			const v = Object.hasOwn(values, UNCONVERTED_LINKEDIN_KEY)
				? values[UNCONVERTED_LINKEDIN_KEY]
				: null;
			return v == null || String(v).trim() === '' ? [] : [{ r, where, value: String(v) }];
		})
	);
	console.log(`${kind}: ${kept.length} LinkedIn value(s) not converted to links`);
	for (const k of kept)
		console.log(
			`  ${k.r.slug}\t${k.r.id}\t${UNCONVERTED_LINKEDIN_KEY}\t${k.where}\t${JSON.stringify(k.value)}`
		);
}

async function main() {
	const pool = scriptPool();
	const client = await pool.connect();
	try {
		await client.query('BEGIN READ ONLY');
		const members = await client.query<Row>(
			`SELECT m.id, g.slug, m.data, m.private_data
			   FROM member m JOIN "group" g ON g.id = m.group_id`
		);
		const requests = await client.query<Row>(
			`SELECT r.id, g.slug, r.data, NULL::jsonb AS private_data
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
