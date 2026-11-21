import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import pg from 'pg';

// F11 usernames through the routes a browser reaches, against a real Postgres:
// the edit page's save and release actions, the profile and edit loads and
// their redirects, the directory payload, and the star and avatar endpoints.
// The SQL is reached only through them.
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
const GROUP = { id: '', slug: 'f11-usernames', name: 'F11', landingMd: null, status: 'active' };
let failCleanup = false;
const ADMIN = {
	id: 'u-admin',
	email: 'admin@example.org',
	subject: 'email:admin@example.org',
	name: 'Admin',
	image: ''
};
mock.module('$lib/server/groups', {
	namedExports: {
		getGroupBySlug: async () => GROUP,
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
		deleteAvatar: async () => { if (failCleanup) throw new Error('audit cleanup unavailable'); },
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

import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

const { migrate } = await import('../../../../../lib/server/migrations');
const { USERNAME_CONTROL } = await import('../../../../../lib/server/usernames');
const profile = await import('./+page.server');
const edit = await import('./edit/+page.server');
const star = await import('./star/+server');
const avatar = await import('./avatar/+server');
const directory = await import('../+page.server');
const groupLayout = await import('../../+layout.server');

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
	failCleanup = false;
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

const retired = async () =>
	(
		await pool!.query<{ username: string }>(
			`SELECT username::text AS username FROM member_username_retired
			  WHERE group_id = $1 ORDER BY username`,
			[GROUP.id]
		)
	).rows.map((r) => r.username);



import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
const lib = fileURLToPath(new URL('../../../../../lib/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '$app/stores') return { url: 'virtual:f11-stores', shortCircuit: true };
    if (!specifier.startsWith('$lib/')) return nextResolve(specifier, context);
    const path = lib + specifier.slice('$lib/'.length);
    return { url: pathToFileURL(existsSync(path) ? path : `${path}.ts`).href, shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (url === 'virtual:f11-stores') return { format: 'module', shortCircuit: true, source: `export const page = { subscribe(run) { run({ url: new URL('https://example.org/home') }); return () => {}; } };` };
    if (!url.endsWith('.svelte')) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    return { format: 'module', source: compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' }).js.code, shortCircuit: true };
  }
});
const { render } = await import('svelte/server');
const home = await import('../../home/+page.server');
const { default: Home } = await import('../../home/+page.svelte');

test('F11 review R4: member home showcase links use the chosen username', opts, async () => {
  assert.equal((await save(adaId, ADA, 'ada-public')).status, 303);
  await pool!.query(`UPDATE member SET data = data || '{"publicProfile":"TRUE"}'::jsonb WHERE id = $1`, [adaId]);
  const loaded = await home.load(event('/home', '', BOB));
  const html = render(Home, { props: { data: { ...loaded, group: GROUP, member: { id: bobId }, isGroupAdmin: false, documents: { manifesto: false, codeOfConduct: false, privacy: false } } } as never }).body;
  const links = [...html.matchAll(/href="([^"]*\/members\/[^"]+)"/g)].map(m => m[1]);
  console.log('HOME_PROFILE_LINKS', JSON.stringify(links));
  assert.deepEqual(links, ['/members/ada-public']);
});

const membersLayout = await import('../+layout.server');

test('F11 review R2: a Unicode look-alike URL is refused before citext folds it', opts, async () => {
  assert.equal((await save(adaId, ADA, 'kate')).status, 303);
  const actual = await view('Kate');
  console.log('UNICODE_URL', JSON.stringify(actual));
  assert.equal(actual.status, 404, 'the Kelvin sign must not resolve to ASCII k');
});

test('F11 review BRANCH-REGRESSION: plain username deletion retains the cleanup recovery route', opts, async () => {
  assert.equal((await save(adaId, ADA, 'ada-delete')).status, 303);
  failCleanup = true;
  const e = event(`${PREFIX}/members/ada-delete/edit?/delete`, 'ada-delete', ADA, { method: 'POST' });
  const deleted = await settle(() => edit.actions.delete!(e));
  const next = deleted.status === 303
    ? deleted
    : await settle(() => membersLayout.load({ ...(e as object), parent: async () => ({ member: null, isGroupAdmin: false }) } as never));
  console.log('REMOVAL_RECOVERY', JSON.stringify({ deleted, next }));
  assert.equal(next.location, `${PREFIX}/removal/${adaId}`, 'a plain form post must reach the UUID-keyed recovery page');
});

