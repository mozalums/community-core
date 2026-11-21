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
const GROUP = { id: '', slug: 'f11-usernames-routes', name: 'F11', landingMd: null, status: 'active' };
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

test(
	'F11 R1: the migration adds member.username, its unique index and the retired table',
	opts,
	async () => {
		const col = await pool!.query(
			`SELECT data_type, udt_name, is_nullable FROM information_schema.columns
		  WHERE table_name = 'member' AND column_name = 'username'`
		);
		assert.equal(col.rows[0]?.udt_name, 'citext');
		assert.equal(col.rows[0]?.is_nullable, 'YES');
		const idx = await pool!.query(
			`SELECT indexdef FROM pg_indexes WHERE indexname = 'member_group_username_key'`
		);
		assert.match(idx.rows[0]?.indexdef ?? '', /UNIQUE INDEX .* \(group_id, username\)/);
		const cols = await pool!.query(
			`SELECT column_name FROM information_schema.columns
		  WHERE table_name = 'member_username_retired' ORDER BY ordinal_position`
		);
		assert.deepEqual(
			cols.rows.map((r) => r.column_name),
			['group_id', 'username', 'member_id', 'retired_at']
		);
	}
);

test(
	'F11 R5: a member claims, changes and clears a username, and every old URL redirects',
	opts,
	async () => {
		// Claim: the save lands on the new canonical URL.
		const claimed = await save(adaId, ADA, 'Ada-Lovelace');
		assert.equal(claimed.status, 303);
		assert.equal(claimed.location, `${PREFIX}/members/ada-lovelace`);

		const page = await view('ada-lovelace');
		assert.equal(page.status, 200);
		assert.equal((page.data!.profile as { ref: string }).ref, 'ada-lovelace');
		// The uuid, and the name in another case, answer 308 to the canonical form,
		// on the clean base and the prefixed one alike, keeping the query.
		assert.deepEqual(await view(adaId), {
			status: 308,
			location: `${PREFIX}/members/ada-lovelace`
		});
		assert.deepEqual(await view(adaId, BOB, ''), {
			status: 308,
			location: '/members/ada-lovelace'
		});
		assert.deepEqual(await view('ADA-LOVELACE'), {
			status: 308,
			location: `${PREFIX}/members/ada-lovelace`
		});

		// Change: the old name is retired and redirects to the new one.
		assert.equal(
			(await save('ada-lovelace', ADA, 'countess')).location,
			`${PREFIX}/members/countess`
		);
		assert.deepEqual(await retired(), ['ada-lovelace']);
		assert.deepEqual(await view('ada-lovelace'), {
			status: 308,
			location: `${PREFIX}/members/countess`
		});
		assert.deepEqual(await view(adaId), { status: 308, location: `${PREFIX}/members/countess` });

		// Nobody else may claim a retired name, through the save or the check.
		const stolen = await save(bobId, BOB, 'ada-lovelace');
		assert.equal(stolen.status, 409);
		assert.match(String(stolen.data!.error), /taken/);
		assert.equal(
			stolen.data!.username,
			'ada-lovelace',
			'the form came back without what was typed'
		);

		// Clear: the uuid is canonical again, and both names redirect to it.
		assert.equal((await save('countess', ADA, '')).location, `${PREFIX}/members/${adaId}`);
		assert.deepEqual(await retired(), ['ada-lovelace', 'countess']);
		assert.equal((await view(adaId)).status, 200);
		assert.deepEqual(await view('countess'), {
			status: 308,
			location: `${PREFIX}/members/${adaId}`
		});
		assert.deepEqual(await view('ada-lovelace'), {
			status: 308,
			location: `${PREFIX}/members/${adaId}`
		});

		// The owner takes a retired name back.
		assert.equal((await save(adaId, ADA, 'ada-lovelace')).status, 303);
		assert.deepEqual(await retired(), ['countess']);
		assert.equal((await view('ada-lovelace')).status, 200);
		assert.equal((await view('nobody-here')).status, 404);
	}
);

test(
	"F11 R1: an admin sees a member's retired names and releases one for anyone to claim",
	opts,
	async () => {
		await save(adaId, ADA, 'first-name');
		await save('first-name', ADA, 'second-name');
		const asAdmin = await settle(() =>
			edit.load(event(`${PREFIX}/members/second-name/edit`, 'second-name', ADMIN))
		);
		assert.deepEqual(asAdmin.data!.retiredUsernames, ['first-name']);
		const own = await settle(() =>
			edit.load(event(`${PREFIX}/members/second-name/edit`, 'second-name', ADA))
		);
		assert.equal(
			own.data!.retiredUsernames,
			null,
			'a member who is not an admin saw the release list'
		);

		const release = (as: typeof ADA) => {
			const body = new FormData();
			body.set('username', 'first-name');
			return settle(() =>
				edit.actions.releaseUsername!(
					event(`${PREFIX}/members/second-name/edit?/releaseUsername`, 'second-name', as, {
						method: 'POST',
						body
					})
				)
			);
		};
		assert.equal((await release(ADA)).status, 403);
		assert.equal((await save(bobId, BOB, 'first-name')).status, 409);
		assert.deepEqual((await release(ADMIN)).data, { released: 'first-name' });
		assert.equal((await view('first-name')).status, 404, 'a released name still redirects');
		assert.equal((await save(bobId, BOB, 'first-name')).location, `${PREFIX}/members/first-name`);
	}
);

test(
	'F11 R5: two members saving one name at once get one success and one "taken"',
	opts,
	async () => {
		const results = await Promise.all([
			save(adaId, ADA, 'same-name'),
			save(bobId, BOB, 'same-name')
		]);
		assert.deepEqual(results.map((r) => r.status).sort(), [303, 409]);
		const lost = results.find((r) => r.status === 409)!;
		assert.match(String(lost.data!.error), /taken/);
		const { rows } = await pool!.query(
			`SELECT count(*)::int AS n FROM member WHERE group_id = $1 AND username = 'same-name'`,
			[GROUP.id]
		);
		assert.equal(rows[0].n, 1);
	}
);

test(
	'F11 R2: the save action refuses what the validator refuses, naming the rule',
	opts,
	async () => {
		const ascii = await save(adaId, ADA, 'аda-lovelace'); // Cyrillic а
		assert.equal(ascii.status, 400);
		assert.match(String(ascii.data!.error), /look-alike/);
		const reserved = await save(adaId, ADA, 'admin');
		assert.equal(reserved.status, 400);
		assert.match(String(reserved.data!.error), /reserved/);
		const digits = await save(adaId, ADA, '12345');
		assert.match(String(digits.data!.error), /at least one letter/);
		const { rows } = await pool!.query(`SELECT username FROM member WHERE id = $1`, [adaId]);
		assert.equal(rows[0].username, null, 'a refused name was saved');
	}
);

test(
	'F11 R3: only the member chooses their username; an admin edit leaves it alone',
	opts,
	async () => {
		await save(adaId, ADA, 'ada-own');
		assert.equal((await save('ada-own', ADMIN, 'admin-picked')).status, 403);
		// The admin's form carries no username control, so saving it changes nothing.
		const body = new FormData();
		const plain = await settle(() =>
			edit.actions.save!(
				event(`${PREFIX}/members/ada-own/edit?/save`, 'ada-own', ADMIN, { method: 'POST', body })
			)
		);
		assert.equal(plain.location, `${PREFIX}/members/ada-own`);
		const shown = await settle(() =>
			edit.load(event(`${PREFIX}/members/ada-own/edit`, 'ada-own', ADMIN))
		);
		assert.equal(shown.data!.username, null, 'an admin was offered the username input');
		const mine = await settle(() =>
			edit.load(event(`${PREFIX}/members/ada-own/edit`, 'ada-own', ADA))
		);
		assert.deepEqual(mine.data!.username, { value: 'ada-own', control: USERNAME_CONTROL });
	}
);

test(
	'F11 R4: edit, star and avatar work under both forms and the app links the canonical one',
	opts,
	async () => {
		await save(adaId, ADA, 'ada-links');

		// The edit page redirects a uuid to the name and renders under the name.
		assert.deepEqual(
			await settle(() => edit.load(event(`${PREFIX}/members/${adaId}/edit`, adaId, ADA))),
			{ status: 308, location: `${PREFIX}/members/ada-links/edit` }
		);
		const editing = await settle(() =>
			edit.load(event(`${PREFIX}/members/ada-links/edit`, 'ada-links', ADA))
		);
		assert.equal(editing.data!.ref, 'ada-links');
		assert.equal(editing.data!.id, adaId);

		// Star by name, unstar by uuid: both land on the same member.
		const starred = async () =>
			(
				await pool!.query(`SELECT count(*)::int AS n FROM member_star WHERE member_id = $1`, [
					adaId
				])
			).rows[0].n;
		await star.POST(
			event(`${PREFIX}/members/ada-links/star`, 'ada-links', BOB, { method: 'POST' })
		);
		assert.equal(await starred(), 1);
		await star.DELETE(event(`${PREFIX}/members/${adaId}/star`, adaId, BOB, { method: 'DELETE' }));
		assert.equal(await starred(), 0);

		// The avatar route answers under either form for its owner.
		for (const seg of ['ada-links', adaId]) {
			const res = await avatar.DELETE(
				event(`${PREFIX}/members/${seg}/avatar`, seg, ADA, { method: 'DELETE' })
			);
			assert.equal(res.status, 200, `avatar under ${seg}`);
		}

		// Links the app builds: directory tiles (and the star endpoint under them),
		// the profile's own Edit and star, and the sidebar's profile link.
		const dir = await settle(() => directory.load(event(`${PREFIX}/members`, '', BOB)));
		const tiles = dir.data!.members as { id: string; ref: string }[];
		assert.equal(tiles.find((t) => t.id === adaId)?.ref, 'ada-links');
		assert.equal(tiles.find((t) => t.id === bobId)?.ref, bobId);
		const shell = (await groupLayout.load({
			params: { slug: GROUP.slug },
			locals: { user: ADA },
			url: new URL(`https://example.org${PREFIX}/members`)
		} as never)) as { member: { ref: string } };
		assert.equal(shell.member.ref, 'ada-links');
	}
);

test(
	'F11 R4: reached by name, a profile its caller may not edit is a 404 whether or not the name exists',
	opts,
	async () => {
		await save(adaId, ADA, 'ada-private');
		for (const seg of ['ada-private', 'no-such-name']) {
			const page = await settle(() => edit.load(event(`${PREFIX}/members/${seg}/edit`, seg, BOB)));
			assert.equal(page.status, 404, `edit ${seg}`);
			const photo = await settle(() =>
				avatar.DELETE(event(`${PREFIX}/members/${seg}/avatar`, seg, BOB, { method: 'DELETE' }))
			);
			assert.equal(photo.status, 404, `avatar ${seg}`);
		}
		// By uuid the old answer stands: the id is not guessable.
		assert.equal(
			(await settle(() => edit.load(event(`${PREFIX}/members/${adaId}/edit`, adaId, BOB)))).status,
			403
		);
	}
);
