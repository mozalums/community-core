import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { readFileSync } from 'node:fs';
import type { AuditEntry } from './audit-core';

// Only flows that write Postgres alone are wired. Each handler is driven as
// SvelteKit would drive it, and two things are asserted: the entry it writes,
// and that the write it describes ran on the audit row's own transaction.

const GROUP = {
	id: '00000000-0000-4000-8000-000000000001',
	slug: 'moz',
	name: 'Moz',
	landingMd: '# old',
	status: 'active'
};
const ADMIN = {
	id: 'u-admin',
	subject: 'email:admin@example.com',
	email: 'admin@example.com',
	name: 'Admin',
	image: ''
};
const entries: AuditEntry[] = [];
const writes: { name: string; inTx: boolean }[] = [];
let inTx = false;
const CLIENT = { query: async () => ({ rows: [{ previous: '# old' }], rowCount: 1 }) };

mock.module('$lib/server/audit', {
	namedExports: {
		auditIn: async (_c: unknown, entry: AuditEntry) => {
			assert.ok(inTx, `${entry.action} was written outside a transaction`);
			entries.push(entry);
		},
		audit: async (entry: AuditEntry) => void entries.push(entry),
		actorOf: (u: typeof ADMIN | null) => ({
			actorSubject: u?.subject ?? null,
			actorEmail: u?.email ?? null
		})
	}
});
const auditReads: { text: string; values: unknown[] }[] = [];
let auditRows: Record<string, unknown>[] = [];
let isAdmin = true;
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string, values: unknown[] = []) => {
			if (!/FROM audit_event/.test(text)) return { rows: [], rowCount: 0 };
			auditReads.push({ text, values });
			return { rows: auditRows, rowCount: auditRows.length };
		},
		withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
			inTx = true;
			try {
				return await fn(CLIENT);
			} finally {
				inTx = false;
			}
		}
	}
});
mock.module('$lib/server/groups', {
	namedExports: {
		getGroupBySlug: async () => GROUP,
		resolveGroupAdmin: async () => isAdmin,
		updateLandingMd: async (c: unknown) => {
			writes.push({ name: 'updateLandingMd', inTx: inTx && c === CLIENT });
			return '# old';
		}
	}
});
mock.module('$lib/server/members', {
	namedExports: { resolveMember: async () => ({ member: null, firstLogin: false }) }
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const ROUTES = '../../routes/group/[slug]/';
type Action = (e: unknown) => Promise<unknown>;
async function action(route: string, name: string): Promise<Action> {
	return (await import(`${ROUTES}${route}+page.server.ts`)).actions[name];
}

function event(user: typeof ADMIN | null, form: Record<string, string>, path = '/admin') {
	const body = new FormData();
	for (const [k, v] of Object.entries(form)) body.set(k, v);
	const url = new URL(`http://localhost/group/${GROUP.slug}${path}`);
	return {
		params: { slug: GROUP.slug },
		locals: { user, sessionId: null, session: null, marketing: { cohort: '', utm: {} } },
		url,
		cookies: { get: () => undefined, delete: () => {} },
		request: new Request(url, { method: 'POST', body })
	};
}

async function run(fn: () => Promise<unknown>): Promise<void> {
	entries.length = 0;
	writes.length = 0;
	try {
		await fn();
	} catch (e) {
		// A redirect is how a handler reports success.
		if (!(e as { location?: string }).location) throw e;
	}
}

function only(action: string): AuditEntry {
	const hits = entries.filter((e) => e.action === action);
	assert.equal(hits.length, 1, `expected one ${action}, got ${JSON.stringify(entries)}`);
	return hits[0];
}

function wroteInsideTx(name: string): void {
	assert.deepEqual(writes, [{ name, inTx: true }]);
}

test('a landing save records before and after on the update’s own transaction', async () => {
	const save = await action('admin/landing/', 'default');
	await run(() => save(event(ADMIN, { md: '# new' })));
	const e = only('landing.updated');
	assert.equal(e.category, 'content');
	assert.deepEqual(e.before, { text: '# old', length: 5, truncated: false });
	assert.deepEqual(e.after, { text: '# new', length: 5, truncated: false });
	wroteInsideTx('updateLandingMd');
});

test('a landing save over the limit records the clipped text and its real length', async () => {
	const save = await action('admin/landing/', 'default');
	const md = 'y'.repeat(4000);
	await run(() => save(event(ADMIN, { md })));
	const e = only('landing.updated');
	assert.deepEqual(e.after, { text: 'y'.repeat(2000), length: 4000, truncated: true });
});

// No transaction spans Postgres and the Sheet, so wrapping a Sheet write in an
// audit transaction records a change that may not have happened, or loses the
// record of one that did. Profile save and delete write Postgres and are
// audited on their own transactions (member-audit.test.ts).
test('the Sheet-backed flows carry no audit wiring', () => {
	for (const route of ['admin/']) {
		const src = readFileSync(new URL(`${ROUTES}${route}+page.server.ts`, import.meta.url), 'utf8');
		assert.doesNotMatch(src, /\$lib\/server\/audit/, `${route} imports the audit module`);
	}
});

// ---------------------------------------------------------------------------
// /admin/audit: the reader
// ---------------------------------------------------------------------------

type Load = (e: unknown) => Promise<{
	blocks: { runId: string | null; rows: { id: string }[] }[];
	filter: { category: string; email: string };
	hasMore: boolean;
}>;

async function auditLoad(query: string, user: typeof ADMIN | null = ADMIN) {
	const { load } = (await import(`${ROUTES}admin/audit/+page.server.ts`)) as { load: Load };
	const url = new URL(`http://localhost/admin/audit${query}`);
	return load({ params: { slug: GROUP.slug }, locals: { user }, url });
}

const row = (id: string, runId: string | null) => ({
	id,
	at: new Date('2026-11-14T00:00:00Z'),
	category: 'membership',
	action: 'member.removed-by-sync',
	actor_subject: 'cli',
	actor_email: null,
	target_email: `${id}@example.com`,
	target_id: id,
	before: null,
	after: null,
	meta: {},
	run_id: runId
});

test('the audit page filters by category and target email, scoped to the group, and pages', async () => {
	auditReads.length = 0;
	auditRows = [];
	const data = await auditLoad('?category=authz&email=x@example.com&page=3');
	assert.equal(auditReads.length, 1);
	const { text, values } = auditReads[0];
	assert.match(text, /group_id = \$1 AND category = \$2 AND target_email = \$3/);
	assert.deepEqual(values, [GROUP.id, 'authz', 'x@example.com', 51, 100]);
	assert.deepEqual(data.filter, { category: 'authz', email: 'x@example.com' });
});

test('an unknown category is ignored rather than passed to SQL', async () => {
	auditReads.length = 0;
	const data = await auditLoad("?category=authz' OR 1=1--");
	assert.doesNotMatch(auditReads[0].text, /category =/);
	assert.equal(data.filter.category, '');
});

test('the audit page folds a run into one block and reports a further page', async () => {
	auditRows = [
		row('a', 'r1'),
		row('b', 'r1'),
		row('c', null),
		...Array.from({ length: 48 }, (_, i) => row(`z${i}`, null))
	];
	const data = await auditLoad('');
	assert.deepEqual(
		data.blocks[0].rows.map((r) => r.id),
		['a', 'b']
	);
	assert.equal(data.hasMore, true, '51 rows for a page of 50 must offer an older page');
	auditRows = [];
});

test('the audit page refuses a signed-in non-admin', async () => {
	isAdmin = false;
	try {
		await assert.rejects(
			() => auditLoad('', { ...ADMIN, subject: 'email:x@example.com' }),
			(e) => (e as { status?: number }).status === 403
		);
	} finally {
		isAdmin = true;
	}
});
