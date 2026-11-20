import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

const PRIVATE_ROLE_FIELDS = EVERY_ROLE_FIELDS.map((f) =>
	['handle', 'startYear', 'endYear', 'website'].includes(f.key)
		? { ...f, visibility: 'private' as const }
		: f
);
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(PRIVATE_ROLE_FIELDS) });

const { default: pg } = await import('pg');
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const group = { id: '', slug: `b28-review-${randomUUID()}`, name: 'Review', status: 'active' };
const reader = {
	id: randomUUID(),
	email: 'reader@example.org',
	subject: 'email:reader@example.org'
};
mock.module('$lib/server/postgres', {
	namedExports: {
		query: (sql: string, values?: unknown[]) => pool!.query(sql, values),
		withTransaction: async () => assert.fail('read path wrote')
	}
});
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => group, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/avatars', {
	namedExports: {
		emailMd5: (s: string) => s,
		ensureAvatarRows: async () => new Map(),
		avatarIdsByEmailMd5: async () => new Map(),
		avatarIdFor: async () => null,
		getAvatarByEmail: async () => null,
		recordGravatar: async () => {}
	}
});
const { migrate } = await import('./migrations');
const { load: directory } = await import('../../routes/group/[slug]/members/+page.server');
const { load: profile } = await import('../../routes/group/[slug]/members/[id]/+page.server');
type Fixture = {
	id: string;
	name: string;
	term: string;
	data: Record<string, string>;
	linkedin?: string;
};
const fixtures: Fixture[] = [
	{ id: randomUUID(), name: 'Handle Target', term: 'qzxhandle', data: { handle: 'qzxhandle' } },
	{
		id: randomUUID(),
		name: 'Tenure Target',
		term: '2015',
		data: { startYear: '2013', endYear: '2017' }
	},
	{
		id: randomUUID(),
		name: 'Website Target',
		term: 'qzxprivatewebsite',
		data: {},
		linkedin: 'qzxprivatewebsite'
	}
];
before(async () => {
	if (!pool) return;
	await migrate(pool);
	const result = await pool.query('INSERT INTO "group" (slug, name) VALUES ($1, $2) RETURNING id', [
		group.slug,
		group.name
	]);
	group.id = result.rows[0].id;
	await pool.query(
		`INSERT INTO member (id, group_id, email, ident_subject, name, data, status)
    VALUES ($1, $2, $3, $4, 'Reader', '{}', 'active')`,
		[reader.id, group.id, reader.email, reader.subject]
	);
	for (const f of fixtures) {
		await pool.query(
			`INSERT INTO member (id, group_id, email, name, linkedin, data, private_data, status)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'active')`,
			[
				f.id,
				group.id,
				`${f.id}@example.org`,
				f.name,
				f.linkedin ?? null,
				JSON.stringify(f.data),
				JSON.stringify(f.linkedin ? { website: f.linkedin } : {})
			]
		);
	}
});
after(async () => {
	if (!pool) return;
	if (group.id) {
		await pool.query('DELETE FROM member WHERE group_id = $1', [group.id]);
		await pool.query('DELETE FROM "group" WHERE id = $1', [group.id]);
	}
	await pool.end();
});
for (const f of fixtures) {
	test(`R1: search cannot find the private ${f.name} that the profile hides`, opts, async () => {
		const p = await profile({
			params: { slug: group.slug, id: f.id },
			locals: { user: reader },
			parent: async () => ({ isGroupAdmin: false })
		} as never);
		for (const secret of Object.values(f.data).concat(f.linkedin ?? [])) {
			assert.ok(!JSON.stringify(p).includes(secret), `profile exposed ${secret}`);
		}
		const result = (await directory({
			params: { slug: group.slug },
			locals: { user: reader },
			url: new URL(
				`https://example.org/group/${group.slug}/members?q=${encodeURIComponent(f.term)}`
			)
		} as never)) as { count: number; members: { name: string }[] };
		assert.deepEqual(
			{ count: result.count, names: result.members.map((m) => m.name) },
			{ count: 0, names: [] }
		);
	});
}
