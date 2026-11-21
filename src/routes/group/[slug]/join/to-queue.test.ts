import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { isRedirect } from '@sveltejs/kit';
import { fakeRequestDb } from '$lib/server/requests-fake';
import { DEFAULT_GROUP_SLUG } from '$lib/group-nav';

// The whole road a stranger travels, every hop resolved the way the router
// resolves it: the join URL, the address its emailed link returns to, the
// request form there, and the admin queue the request notice points at. Each
// URL is taken from the previous hop's output rather than written here, so a
// join link that returns somewhere other than the request form, or a request
// that reaches no queue an admin can open, fails on the hop that broke.

const groups = {
	[DEFAULT_GROUP_SLUG]: { id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44', slug: DEFAULT_GROUP_SLUG },
	other: { id: 'c3d9b2a1-7e4f-4b60-8a2d-5f1e9c0b7d33', slug: 'other' }
} as Record<string, { id: string; slug: string }>;
const groupOf = (slug: string) =>
	groups[slug] && { ...groups[slug], name: 'Example Community', landingMd: null, status: 'active' };

const db = fakeRequestDb();
// The group admin who follows the notice to the queue; the load checks the grant.
const REVIEWER = { email: 'reviewer@example.org', subject: 'email:reviewer@example.org' };
let magicLinks: { email: string; callbackUrl?: string | null }[] = [];
let notices: { reviewUrl: string }[] = [];

mock.module('$lib/server/magic-link', {
	namedExports: {
		sendMagicLink: async (args: { email: string; callbackUrl?: string | null }) => {
			magicLinks.push(args);
			return { ok: true };
		}
	}
});
mock.module('$lib/server/client-address', { namedExports: { clientAddress: () => '192.0.2.1' } });
mock.module('$lib/server/groups', {
	namedExports: {
		getGroupBySlug: async (slug: string) => groupOf(slug) ?? null,
		resolveGroupAdmin: async (_g: unknown, u?: { subject: string } | null) =>
			u?.subject === REVIEWER.subject
	}
});
mock.module('$lib/server/email', {
	namedExports: {
		sendMembershipRequestNotice: async (n: { reviewUrl: string }) => {
			notices.push(n);
			return true;
		},
		sendMembershipApprovedEmail: async () => true
	}
});
// The queue page's actions write audit rows through `$env`; its load, the hop
// read here, never does.
mock.module('$lib/server/audit', { namedExports: { actorOf: () => ({}) } });
mock.module('$lib/server/session-store', { namedExports: { deleteUserSessions: async () => 0 } });
mock.module('$lib/server/rate-limit', {
	namedExports: {
		rateLimitKey: (b: string, id: string) => `${b}:${id}`,
		hashId: (v: string) => v,
		rateLimited: async () => false
	}
});
mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => {
			throw new Error('not reached');
		},
		query: (text: string, values?: unknown[]) => db.query(text, values),
		withTransaction: <T>(fn: (c: unknown) => Promise<T>) => db.withTransaction(fn)
	}
});

const { reroute } = await import('../../../../hooks');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = { load: (e: any) => Promise<any>; actions: Record<string, (e: any) => Promise<any>> };
const pages: Record<string, Page> = {
	join: (await import('./+page.server')) as unknown as Page,
	request: (await import('../request/+page.server')) as unknown as Page,
	'admin/requests': (await import('../admin/requests/+page.server')) as unknown as Page
};

const ORIGIN = 'https://www.example.org';

function route(href: string) {
	const url = new URL(href, ORIGIN);
	assert.equal(url.origin, ORIGIN, `${href} leaves the site`);
	const internal = (reroute as (e: { url: URL }) => string | void)({ url }) ?? url.pathname;
	const m = internal.match(/^\/group\/([^/]+)\/(.+)$/);
	assert.ok(m, `${href} resolves to ${internal}, outside any group`);
	const [, slug, path] = m;
	const page = pages[path];
	assert.ok(page, `${href} resolves to ${internal}, which is not the next step of the funnel`);
	return { url, slug, path, page };
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		if (isRedirect(e)) return e.location;
		throw e;
	}
	assert.fail('expected a redirect');
}

const NOT_A_MEMBER = async () => ({ member: null, isGroupAdmin: false });

async function registerThrough(entry: string, slug: string) {
	db.reset();
	magicLinks = [];
	notices = [];
	const email = 'nomi@example.org';
	const user = { email, subject: `email:${email}`, name: 'Nomi Vance' };

	const join = route(entry);
	assert.equal(join.path, 'join');
	assert.equal(join.slug, slug);
	const guest = async () => ({ member: null, isGroupAdmin: false, user: null });
	assert.deepEqual(await join.page.load({ url: join.url, params: { slug }, parent: guest }), {});

	const body = new FormData();
	body.set('email', email);
	const sent = await join.page.actions.send({
		request: new Request(join.url, { method: 'POST', body }),
		url: join.url,
		params: { slug }
	});
	assert.equal(sent.sent, true);
	assert.equal(magicLinks.length, 1, 'the join form sent no link');

	// The emailed link signs the visitor in and returns them here.
	const callback = route(magicLinks[0].callbackUrl ?? '/');
	assert.equal(callback.path, 'request', 'the join link does not return to the request form');
	assert.equal(callback.slug, slug, 'the join link returns to another group');

	// Coming back to /join once signed in leads to the same place.
	const again = await redirectOf(
		join.page.load({
			url: join.url,
			params: { slug },
			parent: async () => ({ member: null, isGroupAdmin: false, user })
		})
	);
	assert.equal(route(again).url.pathname, callback.url.pathname);

	const form = await callback.page.load({
		url: callback.url,
		params: { slug },
		locals: { user },
		parent: NOT_A_MEMBER
	});
	assert.equal(form.email, email);

	const fields = new FormData();
	fields.set('name', 'Nomi Vance');
	const submitted = await callback.page.actions.default({
		request: new Request(callback.url, { method: 'POST', body: fields }),
		url: callback.url,
		params: { slug },
		locals: { user }
	});
	assert.deepEqual(submitted, { submitted: true });

	assert.equal(notices.length, 1, 'no admin was told about the request');
	const queue = route(notices[0].reviewUrl);
	assert.equal(queue.path, 'admin/requests');
	assert.equal(queue.slug, slug, 'the notice points at another group');
	const listed = await queue.page.load({
		url: queue.url,
		params: { slug: queue.slug },
		locals: { user: REVIEWER }
	});
	assert.equal(listed.loadError, null);
	assert.deepEqual(
		listed.requests.map((r: { email: string; name: string }) => [r.email, r.name]),
		[[email, 'Nomi Vance']]
	);

	assert.equal(db.requests.length, 1);
	assert.equal(db.requests[0].group_id, groups[slug].id);
	assert.equal(db.requests[0].email, email);
	assert.equal(db.requests[0].ident_subject, user.subject);
	assert.deepEqual(db.requests[0].data, { name: 'Nomi Vance' });
}

test('a stranger who registers at /join reaches the admin queue with what they submitted', () =>
	registerThrough('/join', DEFAULT_GROUP_SLUG));

test("a stranger who registers at a group-prefixed join URL reaches that group's admin queue", () =>
	registerThrough('/group/other/join', 'other'));
