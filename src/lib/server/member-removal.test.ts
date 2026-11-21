import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

// The removal across its failure and retry: the purge commits, a cleanup step
// fails, the member row is gone, and the retry finds the address through the
// audit row the purge wrote. Stores are in-memory; the action and the removal
// route are the real ones.

const GROUP = { id: '00000000-0000-4000-8000-0000000000g1', slug: 'example', name: 'Example' };
const ID = '00000000-0000-4000-8000-0000000000aa';
const ADA = { email: 'ada@example.org', subject: 'oidc:ada' };
const ADMIN = { email: 'root@example.org', subject: 'oidc:root' };
const STRANGER = { email: 'eve@example.org', subject: 'oidc:eve' };

let row: { id: string; email: string; identSubject: string } | null;
let audit: { email: string; subject: string } | null;
let rejoined = false;
let photo = true;
let sessions: Map<string, Set<string>>;
let revoked: string[];
let failing: '' | 'avatar' | 'sessions';
let sql: string[];

mock.module('$lib/server/groups', {
	namedExports: {
		getGroupBySlug: async () => GROUP,
		resolveGroupAdmin: async (_g: unknown, u: { subject: string } | null) => u?.subject === ADMIN.subject
	}
});
mock.module('$lib/server/members', {
	namedExports: {
		getMemberById: async () => (row ? { ...row } : null),
		canEditMember: (
			m: { identSubject: string | null; email: string },
			u: { subject: string; email: string } | null,
			admin: boolean
		) => admin || (!!u && (u.subject === m.identSubject || u.email === m.email))
	}
});
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string) => {
			sql.push(text);
			if (/FROM audit_event/.test(text) && audit && !rejoined) {
				return { rows: [{ email: audit.email, subject: audit.subject }], rowCount: 1 };
			}
			return { rows: [], rowCount: 0 };
		},
		withTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
			fn({
				query: async (text: string) => {
					if (/DELETE FROM member WHERE/.test(text) && row) {
						const gone = row;
						row = null;
						audit = { email: gone.email, subject: gone.identSubject };
						return { rows: [{ email: gone.email, ident_subject: gone.identSubject }], rowCount: 1 };
					}
					return { rows: [], rowCount: 0 };
				}
			})
	}
});
mock.module('$lib/server/avatars', {
	namedExports: {
		avatarIdFor: async () => null,
		deleteAvatar: async () => {
			if (failing === 'avatar') throw new Error('avatar store down');
			photo = false;
		}
	}
});
mock.module('$lib/server/gravatar', { namedExports: { gravatarHash: () => 'h' } });
mock.module('$lib/server/session-store', {
	namedExports: {
		SESSION_COOKIE_NAME: 'sid',
		SESSION_COOKIE_OPTIONS: {},
		deleteUserSessions: async (subject: string) => {
			if (failing === 'sessions') throw new Error('redis down');
			revoked.push(subject);
			sessions.delete(subject);
		},
		deleteSession: async (sid: string) => {
			if (failing === 'sessions') throw new Error('redis down');
			for (const set of sessions.values()) set.delete(sid);
		}
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const edit = await import('../../routes/group/[slug]/members/[id]/edit/+page.server');
const removal = await import('../../routes/group/[slug]/removal/[id]/+page.server');

beforeEach(() => {
	row = { id: ID, email: ADA.email, identSubject: ADA.subject };
	audit = null;
	rejoined = false;
	photo = true;
	sessions = new Map([
		[ADA.subject, new Set(['ada-sid'])],
		[`email:${ADA.email}`, new Set(['ada-old'])]
	]);
	revoked = [];
	failing = '';
	sql = [];
});

type Outcome = { status?: number; location?: string; data?: Record<string, unknown> };
const params = { slug: GROUP.slug, id: ID };
function event(user: typeof ADA | null, path = `/members/${ID}/edit`) {
	return {
		params,
		locals: { user },
		cookies: { get: () => 'ada-sid', delete() {} },
		url: new URL(`https://example.org${path}`)
	} as never;
}
async function run(fn: () => unknown): Promise<Outcome> {
	try {
		return (await fn()) as Outcome;
	} catch (e) {
		return e as Outcome;
	}
}

test('E32 R6: a cleanup failure after the purge is a 500 that the edit page sends to the removal page', async () => {
	failing = 'avatar';
	const first = await run(() => edit.actions.delete(event(ADA)));
	assert.equal(first.status, 500);
	assert.equal(first.data?.removalPending, true);
	assert.equal(row, null, 'the purge committed');
	assert.equal(photo, true);
	assert.equal(revoked.length, 0, 'the member was signed out of a removal that did not finish');
});

test('E32 R6: the removal page finishes a failed cleanup from the audit row, and only then redirects', async () => {
	failing = 'sessions';
	assert.equal((await run(() => edit.actions.delete(event(ADA)))).status, 500);
	assert.equal(photo, false);
	assert.equal(sessions.size, 2);

	assert.deepEqual(await removal.load(event(ADA, `/removal/${ID}`)), {});
	const stillDown = await run(() => removal.actions.default(event(ADA, `/removal/${ID}`)));
	assert.equal(stillDown.status, 500, 'a retry that fails again is a failure too');

	failing = '';
	const retry = await run(() => removal.actions.default(event(ADA, `/removal/${ID}`)));
	assert.equal(retry.status, 303);
	assert.equal(retry.location, '/');
	assert.equal(sessions.size, 0);
	assert.ok(sql.some((s) => /FROM audit_event/.test(s) && /member\.deleted/.test(s)));
});

test("E32 R6: the requester's own sessions are revoked last, so a failure before that leaves them able to retry", async () => {
	await run(() => edit.actions.delete(event(ADA)));
	assert.deepEqual(revoked, [`email:${ADA.email}`, ADA.subject]);
});

test('E32 R6: a retry through the edit action finishes cleanup without purging again', async () => {
	failing = 'avatar';
	await run(() => edit.actions.delete(event(ADA)));
	failing = '';
	const retry = await run(() => edit.actions.delete(event(ADA)));
	assert.equal(retry.status, 303);
	assert.equal(photo, false);
	assert.equal(sessions.size, 0);
});

test('E32 R6: an admin can finish it, and stays signed in', async () => {
	failing = 'avatar';
	await run(() => edit.actions.delete(event(ADMIN)));
	failing = '';
	const retry = await run(() => removal.actions.default(event(ADMIN, `/removal/${ID}`)));
	assert.equal(retry.status, 303);
	assert.equal(retry.location, '/members');
	assert.ok(!revoked.includes(ADMIN.subject));
});

test('E32 R6: the removal page is a 404 to anyone else and once the address has rejoined, and sends a guest through sign-in back to it', async () => {
	failing = 'avatar';
	await run(() => edit.actions.delete(event(ADA)));
	failing = '';
	assert.equal((await run(() => removal.load(event(STRANGER, `/removal/${ID}`)))).status, 404);
	assert.equal((await run(() => removal.actions.default(event(STRANGER, `/removal/${ID}`)))).status, 404);
	const signIn = `/login?callbackUrl=${encodeURIComponent(`/removal/${ID}`)}`;
	for (const id of [ID, '00000000-0000-4000-8000-0000000000bb']) {
		const guest = await run(() => removal.load(event(null, `/removal/${id}`)));
		assert.equal(guest.status, 303, 'a signed-out subject has no other way back to recovery');
		assert.equal(guest.location, signIn.replace(ID, id), 'the redirect differs by whether the id is pending');
	}
	assert.equal((await run(() => removal.actions.default(event(null, `/removal/${ID}`)))).location, signIn);
	assert.equal(photo, true, 'a refused request removed something');
	rejoined = true;
	assert.equal((await run(() => removal.load(event(ADA, `/removal/${ID}`)))).status, 404);
	assert.match(
		sql.find((s) => /FROM audit_event/.test(s)) ?? '',
		/NOT EXISTS[\s\S]*FROM member m[\s\S]*m\.email = a\.target_email OR m\.ident_subject = a\.target_subject/
	);
});

test('E32 R6: the edit form hands a pending removal to the removal page, and clean URLs reach it', async () => {
	const { readFileSync } = await import('node:fs');
	const page = readFileSync(
		new URL('../../routes/group/[slug]/members/[id]/edit/+page.svelte', import.meta.url),
		'utf8'
	);
	assert.match(page, /use:enhance=\{enhanceDelete\}/);
	assert.match(
		page,
		// By the uuid the load handed over: under a username URL the segment is
		// the name, which stops resolving once the row is gone.
		/result\.data\?\.removalPending[\s\S]*window\.location\.assign\(`\$\{base\}\/removal\/\$\{data\.id\}`\)/
	);
	const { reroute } = await import('../../hooks');
	assert.equal(
		reroute({ url: new URL(`https://x/removal/${ID}`) } as never),
		`/group/${(await import('../group-nav')).DEFAULT_GROUP_SLUG}/removal/${ID}`
	);
});
