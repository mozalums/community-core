import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// The property under test: an admin page load returns nothing to a signed-in
// non-admin, whatever the admin layout's gate did. SvelteKit's data renderer
// runs only the leaf load for `__data.json?x-sveltekit-invalidated=0001`, and
// on a full request it serializes the leaf's data next to the layout's 403
// node, so the layout cannot be the boundary. These cases drive the installed
// renderer with the real route loads; only database I/O, unused mutation
// services and the parent group layout's result are fixtures. Built from the
// reproduction in issue #99.

const GROUP = {
	id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44',
	slug: 'example',
	name: 'Example',
	status: 'active',
	landing_md: 'Draft landing'
};
const ADMIN_SUBJECT = 'email:admin@example.org';
const MEMBER_COUNT = 262;
const SECRETS = /admin@example\.org|applicant@example\.org|Hidden Applicant|Draft landing/;
// Every query only an admin read should issue. The group lookup itself is not
// here: the guard has to run it to know which group's grant to check.
const ADMIN_READS =
	/FROM group_admin\s+WHERE group_id = \$1 ORDER BY|FROM access_request r|FROM member/;

const issued: string[] = [];
// What the guard's second, post-grant lookup sees; undefined means GROUP.
let fullRow: typeof GROUP | null | undefined;

mock.module('$lib/server/admin', { namedExports: { isAdmin: () => false } });
mock.module('$lib/server/audit', {
	namedExports: { actorOf: () => ({}), auditIn: async () => assert.fail('read only') }
});
mock.module('$lib/server/email', {
	namedExports: { sendMembershipApprovedEmail: async () => assert.fail('read only') }
});
mock.module('$lib/server/session-store', {
	namedExports: { deleteUserSessions: async () => assert.fail('read only') }
});
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (sql: string, params: unknown[] = []) => {
			issued.push(sql);
			if (sql.includes('FROM "group"')) {
				const row = sql.includes('landing_md') && fullRow !== undefined ? fullRow : GROUP;
				return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
			}
			if (sql.includes('SELECT 1 AS one FROM group_admin')) {
				const rows = params[1] === ADMIN_SUBJECT ? [{ one: 1 }] : [];
				return { rows, rowCount: rows.length };
			}
			if (sql.includes('FROM group_admin')) {
				return {
					rows: [
						{
							ident_subject: ADMIN_SUBJECT,
							email: 'admin@example.org',
							created_at: new Date('2026-01-01')
						}
					],
					rowCount: 1
				};
			}
			if (sql.includes('FROM access_request r')) {
				return {
					rows: [
						{
							id: 'req-1',
							email: 'applicant@example.org',
							name: 'Hidden Applicant',
							data: {},
							denials: []
						}
					],
					rowCount: 1
				};
			}
			if (sql.includes('FROM member')) return { rows: [{ n: String(MEMBER_COUNT) }], rowCount: 1 };
			return assert.fail(`unexpected query: ${sql}`);
		},
		withTransaction: async () => assert.fail('read only')
	}
});

const here = (p: string) => new URL(p, import.meta.url).href;
const gate = await import(here('./+layout.server.ts'));
Object.assign(globalThis, { __SVELTEKIT_SERVER_TRACING_ENABLED__: false });
const { render_data } = await import(
	new URL(
		'../../../../../node_modules/@sveltejs/kit/src/runtime/server/data/index.js',
		import.meta.url
	).href
);

type Node = { type: string; status?: number; data?: unknown[] };

// The admin layout is node 2; nodes 0 and 1 stand in for the root and group
// layouts, the latter reporting what the real one resolves for this session.
async function fetchData(
	route: string,
	user: { email: string; subject: string },
	isGroupAdmin: boolean,
	onlyLeaf: boolean
): Promise<{ body: string; nodes: Node[] }> {
	const leaf = await import(here(`./${route ? route + '/' : ''}+page.server.ts`));
	const url = new URL(`https://www.example.org/group/example/admin/${route}`);
	const event = {
		url,
		request: new Request(url),
		params: { slug: GROUP.slug },
		route: { id: `/group/[slug]/admin/${route}` },
		locals: { user },
		tracing: { enabled: false }
	};
	const nodes = [
		{ server: { load: async () => ({}) } },
		{ server: { load: async () => ({ member: null, isGroupAdmin }) } },
		{ server: gate },
		{ server: leaf }
	];
	const res: Response = await render_data(
		event,
		{},
		{ page: { layouts: [0, 1, 2], leaf: 3 } },
		{
			hooks: {
				transport: {},
				handleError: ({ error }: { error: unknown }) => {
					throw error;
				}
			}
		},
		{ _: { nodes: nodes.map((n) => async () => n) } },
		{},
		onlyLeaf ? [false, false, false, true] : [true, true, true, true],
		'never'
	);
	const body = await res.text();
	return { body, nodes: JSON.parse(body).nodes };
}

const ROUTES: { route: string; name: string; expect: RegExp[] }[] = [
	{ route: 'access', name: 'access', expect: [/admin@example\.org/] },
	{ route: 'requests', name: 'requests', expect: [/applicant@example\.org/, /Hidden Applicant/] },
	{ route: '', name: 'overview', expect: [/memberCount/, new RegExp(`\\b${MEMBER_COUNT}\\b`)] },
	{ route: 'landing', name: 'landing', expect: [/Draft landing/] }
];

const OUTSIDER = { email: 'outsider@example.org', subject: 'email:outsider@example.org' };
const ADMIN = { email: 'admin@example.org', subject: ADMIN_SUBJECT };

for (const { route, name, expect } of ROUTES) {
	for (const onlyLeaf of [true, false]) {
		const mode = onlyLeaf ? 'leaf-only' : 'full';

		test(`non-admin ${name} ${mode}: 403 and no admin data`, async () => {
			issued.length = 0;
			const { body, nodes } = await fetchData(route, OUTSIDER, false, onlyLeaf);
			assert.ok(
				nodes.some((n) => n.type === 'error' && n.status === 403),
				`no 403 error node: ${body}`
			);
			assert.doesNotMatch(body, SECRETS);
			assert.doesNotMatch(body, /memberCount/);
			assert.deepEqual(
				issued.filter((sql) => ADMIN_READS.test(sql)),
				[],
				'an admin-only query ran for a non-admin'
			);
		});

		test(`admin ${name} ${mode}: loads its data`, async () => {
			const { body, nodes } = await fetchData(route, ADMIN, true, onlyLeaf);
			assert.ok(!nodes.some((n) => n.type === 'error'), `unexpected error node: ${body}`);
			assert.equal(nodes[3]?.type, 'data', body);
			for (const re of expect) assert.match(body, re);
		});
	}
}

for (const { route, name } of ROUTES) {
    for (const onlyLeaf of [true, false]) {
        test(`R1 ${name} ${onlyLeaf ? 'leaf-only' : 'full'}: no landing text query for a non-admin`, async () => {
            issued.length = 0;
            const { nodes } = await fetchData(route, OUTSIDER, false, onlyLeaf);
            assert.ok(nodes.some((n) => n.type === 'error' && n.status === 403));
            assert.deepEqual(
                issued.filter((sql) => /\blanding_md\b/.test(sql)),
                [],
                'R1: a refused non-admin still queried landing text'
            );
        });
    }
}

const { requireGroupAdmin } = await import(here('../../../../lib/server/route-guards.ts'));

test('requireGroupAdmin returns the landing text to an admin', async () => {
	fullRow = undefined;
	const group = await requireGroupAdmin({ slug: GROUP.slug }, { user: ADMIN });
	assert.equal(group.id, GROUP.id);
	assert.equal(group.landingMd, GROUP.landing_md);
});

test('requireGroupAdmin 404s when the slug names another group after the grant check', async () => {
	fullRow = { ...GROUP, id: 'b0000000-0000-4000-8000-000000000002', landing_md: 'Other' };
	try {
		await assert.rejects(requireGroupAdmin({ slug: GROUP.slug }, { user: ADMIN }), {
			status: 404
		});
	} finally {
		fullRow = undefined;
	}
});

test('requireGroupAdmin 404s when the group is gone after the grant check', async () => {
	fullRow = null;
	try {
		await assert.rejects(requireGroupAdmin({ slug: GROUP.slug }, { user: ADMIN }), {
			status: 404
		});
	} finally {
		fullRow = undefined;
	}
});
