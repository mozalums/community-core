import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import pg from 'pg';

// SvelteKit decodes route params while preserving the encoded URL pathname.
// Exercise canonical redirects through real saves and page loads.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 8 }) : null;

mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => pool,
		query: (text: string, values?: unknown[]) => pool!.query(text, values),
		withTransaction: async <T>(fn: (c: pg.PoolClient) => Promise<T>) => {
			const client = await pool!.connect();
			try {
				await client.query('BEGIN');
				const out = await fn(client);
				await client.query('COMMIT');
				return out;
			} catch (e) {
				await client.query('ROLLBACK');
				throw e;
			} finally {
				client.release();
			}
		}
	}
});
const GROUP = { id: '', slug: 'members', name: 'F11', landingMd: null, status: 'active' };
const ADMIN = {
	id: 'u-admin',
	email: 'admin@example.org',
	subject: 'email:admin@example.org',
	name: 'Admin',
	image: ''
};
mock.module('$lib/server/groups', {
	namedExports: {
		getGroupBySlug: async (slug: string) => slug === GROUP.slug ? GROUP : null,
		resolveGroupAdmin: async (_g: unknown, u: { subject?: string } | null) =>
			u?.subject === ADMIN.subject
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});
mock.module('$lib/server/avatars', {
	namedExports: {
		emailMd5: (s: string) => s,
		ensureAvatarRows: async () => new Map(),
		avatarIdFor: async () => null,
		avatarIdsByEmailMd5: async () => new Map(),
		deleteAvatar: async () => {},
		putAvatar: async () => 'x',
		getAvatarByEmail: async () => null,
		recordGravatar: async () => {},
		ACCEPTED_TYPES: ['image/png'],
		MAX_AVATAR_BYTES: 1
	}
});
mock.module('$lib/server/session-store', {
	namedExports: {
		deleteSession: async () => {},
		deleteUserSessions: async () => 0,
		SESSION_COOKIE_NAME: 'session',
		SESSION_COOKIE_OPTIONS: { path: '/' }
	}
});

const { migrate } = await import('../../../../../lib/server/migrations');
const { USERNAME_CONTROL } = await import('../../../../../lib/server/usernames');
const profile = await import('./+page.server');
const edit = await import('./edit/+page.server');

const user = (email: string) => ({
	id: email,
	email,
	subject: `email:${email}`,
	name: email,
	image: ''
});
const ADA = user('ada@example.org');
const BOB = user('bob@example.org');
let adaId = '';
let bobId = '';
const PREFIX = `/group/${GROUP.slug}`;

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, $2)
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[GROUP.slug, GROUP.name]
	);
	GROUP.id = rows[0].id;
});
beforeEach(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	const add = async (u: typeof ADA, name: string) =>
		(
			await pool.query<{ id: string }>(
				`INSERT INTO member (group_id, email, ident_subject, name, data)
				 VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
				[GROUP.id, u.email, u.subject, name, JSON.stringify({ name })]
			)
		).rows[0].id;
	adaId = await add(ADA, 'Ada Byron');
	bobId = await add(BOB, 'Bob Babbage');
});
after(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
	await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
	await pool.end();
});

type Outcome = { status: number; location?: string; data?: Record<string, unknown> };
async function settle(run: () => unknown): Promise<Outcome> {
	try {
		const out = (await run()) as { status?: number; data?: Record<string, unknown> } | undefined;
		if (out && typeof out.status === 'number' && out.data) return out as Outcome;
		return { status: 200, data: out as Record<string, unknown> };
	} catch (e) {
		const r = e as { status?: number; location?: string; body?: unknown };
		if (typeof r.status === 'number') return { status: r.status, location: r.location };
		throw e;
	}
}

const memberOf = async (u: typeof ADA) =>
	(
		await pool!.query(`SELECT id FROM member WHERE group_id = $1 AND email = $2`, [
			GROUP.id,
			u.email
		])
	).rows[0] ?? null;

function event(path: string, id: string, as: typeof ADA, init?: RequestInit) {
	const href = `https://example.org${path}`;
	return {
		params: { slug: GROUP.slug, id },
		locals: { user: as, session: null, sessionId: 'sid' },
		url: new URL(href),
		request: new Request(href, init),
		cookies: { get: () => undefined, delete: () => {} },
		parent: async () => ({ member: await memberOf(as), isGroupAdmin: as === ADMIN })
	} as never;
}

// The profile page at /members/<seg>, as `as` sees it.
const view = (seg: string, as: typeof ADA = BOB, base = PREFIX) =>
	settle(() => profile.load(event(`${base}/members/${seg}`, seg, as)));

// The edit form's save, posting only the username control.
function save(seg: string, as: typeof ADA, username: string) {
	const body = new FormData();
	body.set(USERNAME_CONTROL, username);
	return settle(() =>
		edit.actions.save!(
			event(`${PREFIX}/members/${seg}/edit?/save`, seg, as, { method: 'POST', body })
		)
	);
}

const { reroute } = await import('../../../../../hooks');
const { decode_pathname } = await import(
	new URL('../utils/url.js', import.meta.resolve('@sveltejs/kit')).href
);
const { parse_route_id, find_route } = await import(
	new URL('../utils/routing.js', import.meta.resolve('@sveltejs/kit')).href
);

test('F11 review 3 R4: encoded group prefix preserves the matched group and profile position', opts, async () => {
	assert.equal((await save(adaId, ADA, 'old-name')).status, 303);
	assert.equal((await save('old-name', ADA, 'current-name')).status, 303);
	const actual = [];
	const expected = [];
	for (const prefix of ['/%67roup/members', '/g%72oup/members']) {
		for (const segment of [adaId, 'old-name']) {
			for (const suffix of ['', '/edit']) {
				const path = `${prefix}/members/${segment}${suffix}?welcome=1`;
				const url = new URL(`https://example.org${path}`);
				const routeId = `/group/[slug]/members/[id]${suffix}`;
				const routed = reroute({ url } as never) ?? url.pathname;
				const matched = find_route(
					decode_pathname(routed),
					[{ id: routeId, ...parse_route_id(routeId) }],
					{}
				);
				assert.deepEqual(matched?.params, { slug: GROUP.slug, id: segment });
				const loader = suffix ? edit.load : profile.load;
				const result = await settle(() => loader(event(path, matched.params.id, ADA)));
				actual.push({ path, status: result.status, location: result.location });
				expected.push({ path, status: 308, location: `${prefix}/members/current-name${suffix}?welcome=1` });
			}
		}
	}
	console.log('ENCODED_GROUP_PREFIX', JSON.stringify(actual));
	assert.deepEqual(actual, expected);
});
