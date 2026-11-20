import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, test, mock } from 'node:test';
import pg from 'pg';

// Migration 11 against a real Postgres, then the resolver reading what it
// wrote. The copy reads group.column_map, which migration 15 drops, so it runs
// in a schema of its own held at version 14: the database a pre-15 backup
// restores to before the remaining migrations apply.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };

let pool: pg.Pool;

mock.module('$lib/server/postgres', {
	namedExports: { query: (text: string, values?: unknown[]) => pool.query(text, values) }
});
mock.module('$lib/server/admin', { namedExports: { isAdmin: () => false } });

const { MIGRATIONS, migrate } = await import('./migrations');
const { resolveGroupAdmin } = await import('./groups');
const COPY = MIGRATIONS.find((m) => m.version === 11)!;
const SCHEMA = `e39_${randomBytes(4).toString('hex')}`;

let groupId = '';
let mappedGroupId = '';

before(async () => {
	if (!url) return;
	// The search path names a schema that does not exist yet, which Postgres
	// skips: migrate() lands in public and leaves the extensions there, where
	// the other suites expect them.
	pool = new pg.Pool({
		connectionString: url,
		max: 3,
		options: `-c search_path=${SCHEMA},public`
	});
	await migrate(pool);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`CREATE SCHEMA ${SCHEMA}`);
		for (const m of MIGRATIONS.filter((x) => x.version <= 14)) await client.query(m.sql);
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
});

after(async () => {
	await pool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	await pool?.end();
});

beforeEach(async () => {
	if (!url) return;
	await pool.query(`DELETE FROM "group" WHERE slug IN ('e39-default', 'e39-mapped')`);
	groupId = (
		await pool.query<{ id: string }>(
			`INSERT INTO "group" (slug, name) VALUES ('e39-default', 'Default') RETURNING id`
		)
	).rows[0].id;
	mappedGroupId = (
		await pool.query<{ id: string }>(
			`INSERT INTO "group" (slug, name, column_map)
			 VALUES ('e39-mapped', 'Mapped', '{"dashPermissions": ["Role", "Access Level"]}')
			 RETURNING id`
		)
	).rows[0].id;
	const members: [string, string, Record<string, string>, string?][] = [
		[groupId, 'Boss@Example.com', { 'Dash Permissions': 'admin' }],
		[groupId, 'list@example.com', { ' dash \n permissions ': 'Editor; OWNER ' }],
		[groupId, 'editor@example.com', { 'Dash Permissions': 'editor' }],
		[groupId, 'admins@example.com', { 'Dash Permissions': 'admins' }],
		[groupId, 'gone@example.com', { 'Dash Permissions': 'admin' }, 'removed'],
		[groupId, 'plain@example.com', {}],
		[groupId, 'already@example.com', { 'Dash Permissions': 'superadmin' }],
		[mappedGroupId, 'mapped@example.com', { 'Access Level': 'admin' }],
		[mappedGroupId, 'default-header@example.com', { 'Dash Permissions': 'admin' }]
	];
	for (const [g, email, data, status] of members) {
		await pool.query(
			`INSERT INTO member (group_id, email, data, status) VALUES ($1, $2, $3::jsonb, $4)`,
			[g, email, JSON.stringify(data), status ?? 'active']
		);
	}
	await pool.query(
		`INSERT INTO group_admin (group_id, ident_subject, email)
		 VALUES ($1, 'email:already@example.com', 'already@example.com'),
		        ($1, 'email:someone-else@example.com', NULL)`,
		[groupId]
	);
});

async function admins(g: string): Promise<string[]> {
	return (
		await pool.query<{ ident_subject: string }>(
			`SELECT ident_subject FROM group_admin WHERE group_id = $1 ORDER BY 1`,
			[g]
		)
	).rows.map((r) => r.ident_subject);
}

async function runCopy(): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(COPY.sql);
		await client.query('COMMIT');
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	} finally {
		client.release();
	}
}

const asUser = (email: string) => ({ subject: `email:${email}`, email });
const group = (id: string) => ({ id });

test(
	'pg: the copy grants exactly the active members the sheet named, and is idempotent',
	opts,
	async () => {
		await runCopy();
		await runCopy();
		assert.deepEqual(await admins(groupId), [
			'email:already@example.com',
			'email:boss@example.com',
			'email:list@example.com',
			'email:someone-else@example.com'
		]);
		assert.deepEqual(await admins(mappedGroupId), ['email:mapped@example.com']);
	}
);

test('pg: a member the migration copied is an admin; one it skipped is not', opts, async () => {
	assert.equal(await resolveGroupAdmin(group(groupId), asUser('boss@example.com')), false);
	await runCopy();
	assert.equal(await resolveGroupAdmin(group(groupId), asUser('boss@example.com')), true);
	assert.equal(await resolveGroupAdmin(group(groupId), asUser('editor@example.com')), false);
	assert.equal(await resolveGroupAdmin(group(groupId), asUser('gone@example.com')), false);
	assert.equal(
		await resolveGroupAdmin(group(mappedGroupId), asUser('default-header@example.com')),
		false
	);
});

test('pg: the copy aborts its transaction if group_admin would shrink', opts, async () => {
	await pool.query(`
		CREATE OR REPLACE FUNCTION e39_shrink() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN DELETE FROM group_admin WHERE (group_id, ident_subject) <> (NEW.group_id, NEW.ident_subject); RETURN NEW; END $$;
		CREATE TRIGGER e39_shrink AFTER INSERT ON group_admin FOR EACH ROW EXECUTE FUNCTION e39_shrink();
	`);
	try {
		await assert.rejects(runCopy, /group_admin shrank/);
		assert.deepEqual(await admins(groupId), [
			'email:already@example.com',
			'email:someone-else@example.com'
		]);
	} finally {
		await pool.query(`DROP TRIGGER e39_shrink ON group_admin; DROP FUNCTION e39_shrink();`);
	}
});

// The resolver this migration replaces, as trunk ran it in hasSheetAdmin: a
// throw anywhere was answered with "not an admin". Frozen here because the
// modules that held it (sheet-source.ts, dash-access-core.ts) are deleted, and
// the copy still has to agree with what they decided.
const normHeader = (h: string) => h.replace(/\s+/g, ' ').trim().toLowerCase();

function resolveHeader(keys: string[], spec: string | string[] | undefined, fallback: string) {
	const wanted = (spec ? (Array.isArray(spec) ? spec : [spec]) : [fallback]).map(normHeader);
	const byNorm = new Map(keys.map((k) => [normHeader(k), k]));
	for (const w of wanted) {
		const hit = byNorm.get(w);
		if (hit) return hit;
	}
	return null;
}

const ADMIN_VALUES = new Set(['admin', 'owner', 'superadmin']);
const isAdminValue = (cell: string) =>
	cell
		.toLowerCase()
		.split(/[,;]/)
		.map((s) => s.trim())
		.some((s) => ADMIN_VALUES.has(s));

function legacyAdmin(data: unknown, spec: unknown): boolean {
	if (!data) return false;
	try {
		const key = resolveHeader(Object.keys(data), spec as string[], 'Dash Permissions');
		return !!key && isAdminValue(String((data as Record<string, unknown>)[key] ?? ''));
	} catch {
		return false;
	}
}

function prng(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test('pg: the copy grants exactly whom the old resolver did, across generated rows', opts, async () => {
	const rand = prng(39);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
	const SPACE = [' ', '  ', '\u00a0', '\t', '\n', '\u3000', '\ufeff', '\u2028', '\u200b', ''];
	const WORDS = [
		['Dash', 'DASH', 'dash', 'Da\u0130sh'],
		['Permissions', 'PERMISSIONS', 'Perm\u0130ssions', 'permissions'],
		['Rank', 'RANK', 'Ran\u212a', 'rank']
	];
	const header = () => {
		const [first, second] = rand() < 0.7 ? [WORDS[0], WORDS[1]] : [WORDS[2], null];
		const words = [pick(first), ...(second ? [pick(second)] : [])].join(pick(SPACE) || ' ');
		return pick(SPACE) + words + pick(SPACE);
	};
	const ROLES = ['admin', 'ADMIN', 'Owner', 'superadmin', 'editor', 'admins', 'adm\u0130n', ''];
	const cell = (): unknown => {
		const r = rand();
		if (r < 0.75) {
			const parts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
				return pick(SPACE) + pick(ROLES) + pick(SPACE);
			});
			return parts.join(pick([',', ';', ', ', ';\u00a0']));
		}
		return pick([['editor', 'admin'], [['x', ['owner']]], 1, null, true, { a: 'admin' }, []]);
	};
	const SPECS: unknown[] = [
		undefined, '', ' ', null, 0, false, 1, true, { x: 1 }, [], 'Rank', ' rank\u00a0',
		'Dash Permissions', ['Rank', 'Dash Permissions'], ['Nope', 'rank'], ['Rank', 1]
	];

	const created: string[] = [];
	const expected = new Map<string, string[]>();
	try {
		for (const [i, spec] of SPECS.entries()) {
			const map = spec === undefined ? {} : { dashPermissions: spec };
			const g = (
				await pool.query<{ id: string }>(
					`INSERT INTO "group" (slug, name, column_map) VALUES ($1, $1, $2) RETURNING id`,
					[`e39-fuzz-${i}`, JSON.stringify(map)]
				)
			).rows[0].id;
			created.push(g);
			const want: string[] = [];
			for (let n = 0; n < 40; n++) {
				const raw: Record<string, unknown> = {};
				for (let k = 0, keys = 1 + Math.floor(rand() * 4); k < keys; k++) raw[header()] = cell();
				const status = rand() < 0.1 ? 'removed' : 'active';
				const email = `Fuzz${n}@Example.com`;
				const { rows } = await pool.query<{ data: unknown }>(
					`INSERT INTO member (group_id, email, data, status) VALUES ($1, $2, $3, $4) RETURNING data`,
					[g, email, JSON.stringify(raw), status]
				);
				if (status === 'active' && legacyAdmin(rows[0].data, spec)) {
					want.push(`email:${email.toLowerCase()}`);
				}
			}
			expected.set(g, want.sort());
		}
		await runCopy();
		for (const [i, g] of created.entries()) {
			assert.deepEqual(await admins(g), expected.get(g), `spec ${JSON.stringify(SPECS[i])}`);
		}
		const granted = [...expected.values()].reduce((n, xs) => n + xs.length, 0);
		assert.ok(granted > 20 && granted < SPECS.length * 40 * 0.5, `${granted} grants`);
	} finally {
		await pool.query(`DELETE FROM "group" WHERE slug LIKE 'e39-fuzz-%'`);
	}
});

// Every code point through the copy's lowercasing, judged by the runtime that
// decided the grants. Blocks of code points become one header so the sweep
// stays a few thousand groups; a single wrong mapping in a block flips it.
test('pg: the copy lowercases headers and emails as String.toLowerCase does', opts, async () => {
	const rand = prng(1789);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
	const all: string[] = [];
	for (let cp = 1; cp <= 0x10ffff; cp++) {
		if (cp < 0xd800 || cp > 0xdfff) all.push(String.fromCodePoint(cp));
	}
	const pairs = all.filter((c) => c.toLowerCase() !== c);
	// Σ next to cased, uncased and case-ignorable neighbours on either side.
	const SIGMA = ['Σ', 'σ', 'ς', 'A', 'Ᲊ', 'İ', '1', ' ', '.', "'", '­', '́', 'ͅ', 'ʰ', '𐐀', 'ა'];
	const cases: { spec: string; data: Record<string, string>; email: string }[] = [];
	for (let i = 0; i < all.length; i += 1024) {
		const block = all.slice(i, i + 1024).join('');
		cases.push({ spec: block.toLowerCase(), data: { [block]: 'admin' }, email: `b${i}@example.com` });
		cases.push({ spec: block, data: { [block.toLowerCase()]: 'admin' }, email: `r${i}@example.com` });
	}
	for (const [i, c] of pairs.entries()) {
		const l = c.toLowerCase();
		cases.push({ spec: c, data: { [c]: 'admin', [l]: 'editor' }, email: `${c}${i}@Example.com` });
		cases.push({ spec: l, data: { [c]: 'editor', [l]: 'admin' }, email: `p${i}@example.com` });
	}
	for (let i = 0; i < 400; i++) {
		const word = () => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pick(SIGMA)).join('');
		const key = word();
		cases.push({ spec: rand() < 0.5 ? key.toLowerCase() : word(), data: { [key]: 'admin' }, email: `s${i}@example.com` });
	}

	try {
		const groups = (
			await pool.query<{ id: string; slug: string }>(
				`INSERT INTO "group" (slug, name, column_map)
				 SELECT s, s, jsonb_build_object('dashPermissions', h)
				   FROM unnest($1::text[], $2::text[]) AS t(s, h)
				 RETURNING id, slug`,
				[cases.map((_, i) => `e39-case-${i}`), cases.map((c) => c.spec)]
			)
		).rows;
		const bySlug = new Map(groups.map((g) => [g.slug, g.id]));
		const ids = cases.map((_, i) => bySlug.get(`e39-case-${i}`)!);
		const members = (
			await pool.query<{ group_id: string; email: string; data: Record<string, string> }>(
				`INSERT INTO member (group_id, email, data)
				 SELECT * FROM unnest($1::uuid[], $2::text[], $3::jsonb[])
				 RETURNING group_id, email, data`,
				[ids, cases.map((c) => c.email), cases.map((c) => JSON.stringify(c.data))]
			)
		).rows;
		const specOf = new Map(ids.map((id, i) => [id, cases[i].spec]));
		const want = members
			.filter((m) => legacyAdmin(m.data, specOf.get(m.group_id)))
			.map((m) => `${m.group_id} email:${m.email.toLowerCase()}`)
			.sort();
		await runCopy();
		const got = (
			await pool.query<{ k: string }>(
				`SELECT group_id || ' ' || ident_subject AS k FROM group_admin WHERE group_id = ANY($1::uuid[])`,
				[ids]
			)
		).rows
			.map((r) => r.k)
			.sort();
		assert.deepEqual(got, want);
		assert.ok(want.length > pairs.length && want.length < cases.length, `${want.length} grants`);
	} finally {
		await pool.query(`DELETE FROM "group" WHERE slug LIKE 'e39-case-%'`);
	}
});
