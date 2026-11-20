import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { loadExportMembers, memberCsv } from './member-export';
import { applyImportPlan, previewImport, type Db } from './member-import';
import { GROUP_LOCK_SQL, createMemberIn, updateMemberIn, type Client } from './member-write-core';
import { migrate } from './migrations';

// The import's SQL against a real schema: migration 14, citext matching in the
// set difference, and the advisory lock actually blocking.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 6 }) : null;

const SLUG = 'import-test';
const ACTOR = { actorSubject: 'email:admin@example.com', actorEmail: 'admin@example.com' };
let group = { id: '', slug: SLUG };

async function tx<T>(fn: (c: Db) => Promise<T>): Promise<T> {
	const c = await pool!.connect();
	try {
		await c.query('BEGIN');
		const out = await fn(c as unknown as Db);
		await c.query('COMMIT');
		return out;
	} catch (e) {
		await c.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		c.release();
	}
}

async function previewAndApply(
	text: string,
	mode: 'merge' | 'replace',
	typed: string | null = null
) {
	const p = await tx((c) => previewImport(c, group, ACTOR, { text, mode, confirmPercent: 10 }));
	assert.ok(p.ok && p.planId, JSON.stringify(p));
	return tx((c) =>
		applyImportPlan(
			c,
			group,
			ACTOR,
			{ planId: p.planId!, digest: p.digest, typed, confirmPercent: 10 },
			{ recordPrivateValues: false }
		)
	);
}

before(async () => {
	if (!pool) return;
	await migrate(pool);
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name) VALUES ($1, 'Import test')
		 ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
		[SLUG]
	);
	group = { id: rows[0].id, slug: SLUG };
});

beforeEach(async () => {
	if (!pool) return;
	await pool.query('DELETE FROM member WHERE group_id = $1', [group.id]);
	await pool.query('DELETE FROM member_import_plan WHERE group_id = $1', [group.id]);
	for (let i = 0; i < 10; i++) {
		await pool.query(
			`INSERT INTO member (group_id, email, name, data, private_data) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
			[
				group.id,
				`M${i}@Example.com`,
				`M${i}`,
				JSON.stringify({ name: `M${i}`, country: `=H${i}` }),
				JSON.stringify({ phone: `+${i} Road` })
			]
		);
	}
	await pool.query(
		`INSERT INTO member (group_id, email, status, data) VALUES ($1, 'gone@example.com', 'removed', '{"name":"Gone"}')`,
		[group.id]
	);
});

after(async () => {
	await pool?.end();
});

test(
	'pg R15: a full export round-trips through migration 14 and the real roster as no change',
	opts,
	async () => {
		const full = { includePrivate: true, includeRemoved: true };
		const text = memberCsv(await loadExportMembers(pool!, group.id, full), full);
		const before = await loadExportMembers(pool!, group.id, full);
		const out = await previewAndApply(text, 'replace');
		assert.deepEqual(out.ok && [out.added, out.changed, out.removed, out.unchanged], [0, 0, 0, 11]);
		assert.deepEqual(await loadExportMembers(pool!, group.id, full), before);
	}
);

test(
	'pg R5: the set difference matches addresses case-insensitively and removes only the absent',
	opts,
	async () => {
		const rows = ['Email', ...Array.from({ length: 9 }, (_, i) => `m${i}@EXAMPLE.COM`)];
		const out = await previewAndApply(rows.join('\r\n') + '\r\n', 'replace');
		assert.ok(out.ok && out.removed === 1 && out.unchanged === 9, JSON.stringify(out));
		const { rows: removed } = await pool!.query<{ email: string }>(
			`SELECT email::text AS email FROM member WHERE group_id = $1 AND status = 'removed' ORDER BY email`,
			[group.id]
		);
		assert.deepEqual(removed.map((r) => r.email).sort(), ['M9@Example.com', 'gone@example.com']);
		const { rows: audit } = await pool!.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM audit_event WHERE run_id = $1`,
			[out.ok ? out.runId : null]
		);
		assert.equal(audit[0].n, '2', 'one run row and one removal row');
	}
);

test('pg R6: an apply waits for a profile save in flight, then sees its write', opts, async () => {
	const p = await tx((c) =>
		previewImport(c, group, ACTOR, {
			text: 'Email,City\r\nm0@example.com,Paris\r\n',
			mode: 'merge',
			confirmPercent: 10
		})
	);
	assert.ok(p.ok && p.planId);

	const save = await pool!.connect();
	await save.query('BEGIN');
	const { rows: m0 } = await save.query<{ id: string }>(
		`SELECT id FROM member WHERE group_id = $1 AND email = 'm0@example.com'`,
		[group.id]
	);
	await updateMemberIn(save as unknown as Client, {
		group,
		memberId: m0[0].id,
		patch: { city: 'Oslo' },
		actor: ACTOR,
		authority: { admin: true },
		writer: 'form',
		recordPrivateValues: false
	});

	let settled = false;
	const apply = tx((c) =>
		applyImportPlan(
			c,
			group,
			ACTOR,
			{ planId: p.planId!, digest: p.digest, typed: null, confirmPercent: 10 },
			{ recordPrivateValues: false }
		)
	).finally(() => (settled = true));
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(settled, false, 'the apply did not wait for the save');
	await save.query('COMMIT');
	save.release();

	const out = await apply;
	assert.ok(
		!out.ok && /changed after this preview/.test(out.message),
		'the apply read a roster from before the save'
	);
});

// Row locks alone order an edit of an existing member against an apply, since
// the apply reads the roster FOR UPDATE. A member created mid-apply has no row
// to lock yet, so only the shared group key orders an approval against it.
test(
	'pg R6: an apply waits for an approval creating a member, then refuses the roster it changed',
	opts,
	async () => {
		const everyone = Array.from({ length: 10 }, (_, i) => `M${i}@Example.com`);
		const p = await tx((c) =>
			previewImport(c, group, ACTOR, {
				text: ['Email', ...everyone].join('\r\n') + '\r\n',
				mode: 'replace',
				confirmPercent: 10
			})
		);
		assert.ok(p.ok && p.planId && p.diff.removed.length === 0, JSON.stringify(p));

		const approval = await pool!.connect();
		let apply: Promise<Awaited<ReturnType<typeof applyImportPlan>>> | null = null;
		let waited = false;
		try {
			await approval.query('BEGIN');
			const created = await createMemberIn(approval as unknown as Client, {
				group,
				email: 'approved@example.com',
				values: { name: 'Approved' },
				actor: ACTOR,
				recordPrivateValues: false
			});
			assert.ok(created);

			let settled = false;
			apply = tx((c) =>
				applyImportPlan(
					c,
					group,
					ACTOR,
					{ planId: p.planId!, digest: p.digest, typed: null, confirmPercent: 10 },
					{ recordPrivateValues: false }
				)
			).finally(() => (settled = true));
			await new Promise((r) => setTimeout(r, 400));
			waited = !settled;
			await approval.query('COMMIT');
		} finally {
			await approval.query('ROLLBACK').catch(() => {});
			approval.release();
		}
		const out = await apply!;
		assert.ok(waited, 'the apply did not wait for the approval');
		assert.ok(!out.ok && /changed after this preview/.test(out.message), JSON.stringify(out));
		const { rows } = await pool!.query<{ status: string }>(
			`SELECT status FROM member WHERE group_id = $1 AND email = 'approved@example.com'`,
			[group.id]
		);
		assert.deepEqual(rows, [{ status: 'active' }]);
	}
);

test(
	'pg R6: the lock is released when the transaction ends, with nothing left to clear',
	opts,
	async () => {
		const held = async () =>
			(
				await pool!.query<{ n: string }>(
					`SELECT count(*)::text AS n FROM pg_locks
					  WHERE locktype = 'advisory' AND objsubid = 1
					    AND ((classid::bigint << 32) | objid::bigint)
					        = hashtextextended('member-write:' || $1::text, 0)`,
					[group.id]
				)
			).rows[0].n;
		await tx(async (c) => {
			await c.query(GROUP_LOCK_SQL, [group.id]);
			assert.equal(await held(), '1', 'the query does not see the lock it is meant to count');
		});
		assert.equal(await held(), '0');
	}
);

test(
	'pg R7: exponent numbers and nested objects survive the stored plan, and a numeric First Name is editable',
	opts,
	async () => {
		const text =
			'Email,Name,Bio\r\n' +
			'm0@example.com,json:42,"json:{""z"":{""y"":1e2,""x"":2},""a"":9007199254740993}"\r\n' +
			'new@example.com,json:7,\r\n';
		const out = await previewAndApply(text, 'merge');
		assert.ok(out.ok && out.added === 1 && out.changed === 1, JSON.stringify(out));
		const { rows } = await pool!.query<{ email: string; name: string; data: string }>(
			`SELECT email::text AS email, name, data::text AS data FROM member
			  WHERE group_id = $1 AND email IN ('m0@example.com', 'new@example.com') ORDER BY email`,
			[group.id]
		);
		assert.deepEqual(
			rows.map((r) => [r.email, r.name]),
			[
				['M0@Example.com', '42'],
				['new@example.com', '7']
			]
		);
		assert.match(rows[0].data, /"a": 9007199254740993/);
		assert.match(rows[0].data, /"name": 42/);
	}
);

test(
	'pg R2/R14: typed columns and the audit read values by JSON kind, never through JS conversion',
	opts,
	async () => {
		await pool!.query(
			`UPDATE member SET data = data || '{"bio":true}' WHERE group_id = $1 AND email = 'M1@Example.com'`,
			[group.id]
		);
		const text =
			'Email,Name,City,Phone,Bio\r\n' +
			'm0@example.com,"json:[{""valueOf"":""x""},1]","json:{""toString"":1,""valueOf"":{}}",,\r\n' +
			'm1@example.com,M1,,+1 Road,"json:""json:true"""\r\n';
		const out = await previewAndApply(text, 'merge');
		assert.ok(out.ok && out.changed === 2, JSON.stringify(out));
		const { rows } = await pool!.query<{
			email: string;
			name: string;
			city: string | null;
			bio: unknown;
		}>(
			`SELECT email::text AS email, name, city, data->'bio' AS bio FROM member
			  WHERE group_id = $1 AND email IN ('M0@Example.com', 'M1@Example.com') ORDER BY email`,
			[group.id]
		);
		assert.deepEqual(
			rows.map((r) => [r.name, r.city, r.bio]),
			[
				['[object Object],1', '[object Object]', null],
				['M1', null, 'json:true']
			]
		);
		const { rows: audit } = await pool!.query<{ email: string; before: object; after: object }>(
			`SELECT target_email AS email, before, after FROM audit_event
			  WHERE run_id = $1 AND action = 'member.import-updated' ORDER BY target_email`,
			[out.ok ? out.runId : null]
		);
		assert.deepEqual(
			audit.map((r) => [r.before, r.after]),
			[
				[
					{ name: 'M0', city: '', phone: '<set>' },
					{
						name: 'json:[{"valueOf":"x"},1]',
						city: 'json:{"toString":1,"valueOf":{}}',
						phone: '<empty>'
					}
				],
				[{ bio: 'json:true' }, { bio: 'json:"json:true"' }]
			]
		);
	}
);
