import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';
import { applyImportPlan, previewImport, runImport, type Db } from './member-import';
import { memberCsv } from './member-export';
import { GROUP_LOCK_SQL, updateMemberIn, type Client } from './member-write-core';

// The import's SQL driven against an in-memory roster that answers the
// statements member-import.ts sends. The fake implements the removal the way
// the statement says it works (active, and not among the file's addresses or
// among the rows marked removed), so a test that counts removals is counting
// what that WHERE clause selects. Real-Postgres coverage of the same paths is
// member-import.pg.test.ts.

type Row = {
	id: string;
	email: string;
	status: string;
	data: Record<string, unknown>;
	private_data: Record<string, unknown>;
	name: string | null;
	city: string | null;
};
type Plan = {
	id: string;
	group_id: string;
	created_by: string;
	mode: string;
	keys: string;
	rows: string;
	digest: string;
};

const GROUP = { id: 'g-1', slug: 'example' };
const ACTOR = { actorSubject: 'email:admin@example.com', actorEmail: 'admin@example.com' };
const PCT = 10;

let members: Row[] = [];
let plans: Plan[] = [];
let sql: { text: string; values: unknown[] }[] = [];
let audits: Record<string, unknown>[] = [];
let ids = 0;

function seed(n: number, extra: Partial<Row>[] = []) {
	members = [
		...Array.from({ length: n }, (_, i) => row(`m${i}@example.com`, { data: { name: `M${i}` } })),
		...extra.map((e) => row(e.email!, e))
	];
}
function row(email: string, r: Partial<Row> = {}): Row {
	return {
		id: `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
		email,
		status: 'active',
		data: {},
		private_data: {},
		name: null,
		city: null,
		...r
	};
}

const client: Db = {
	async query(text: string, values: unknown[] = []) {
		sql.push({ text, values });
		const t = text.replace(/\s+/g, ' ').trim();
		const out = (rows: unknown[]) => ({ rows: rows as never[], rowCount: rows.length });
		if (t.startsWith('SELECT pg_advisory')) return out([]);
		if (t.startsWith('SELECT id, email::text AS email, status, data::text')) {
			return out(
				[...members]
					.sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()))
					.map((m) => ({
						...m,
						data: JSON.stringify(m.data),
						private_data: JSON.stringify(m.private_data)
					}))
			);
		}
		if (t.startsWith('DELETE FROM member_import_plan WHERE created_at')) return out([]);
		if (t.startsWith('INSERT INTO member_import_plan')) {
			const [group_id, created_by, mode, keys, rows, digest] = values as string[];
			const id = `00000000-0000-4000-9000-${String(++ids).padStart(12, '0')}`;
			plans.push({ id, group_id, created_by, mode, keys, rows, digest });
			return out([{ id }]);
		}
		if (t.startsWith('SELECT mode, keys::text')) {
			const [id, g, by] = values;
			// rows #>> '{}' returns the stored jsonb string's content.
			return out(
				plans
					.filter((p) => p.id === id && p.group_id === g && p.created_by === by)
					.map((p) => ({ ...p, rows: JSON.parse(p.rows) }))
			);
		}
		if (t.startsWith('DELETE FROM member_import_plan WHERE id')) {
			plans = plans.filter((p) => p.id !== values[0]);
			return out([]);
		}
		if (t.startsWith('INSERT INTO member (')) {
			const [, email, name, city, data, priv] = values as string[];
			if (members.some((m) => m.email.toLowerCase() === email.toLowerCase()))
				throw new Error('duplicate key');
			const r = row(email, {
				name,
				city,
				data: JSON.parse(data),
				private_data: JSON.parse(priv)
			});
			members.push(r);
			return out([{ id: r.id }]);
		}
		if (t.startsWith("UPDATE member SET status = 'removed'")) {
			const keep = new Set((values[1] as string[]).map((e) => e.toLowerCase()));
			const marked = new Set((values[2] as string[]).map((e) => e.toLowerCase()));
			const hit = members.filter(
				(m) =>
					m.status === 'active' &&
					(!keep.has(m.email.toLowerCase()) || marked.has(m.email.toLowerCase()))
			);
			for (const m of hit) m.status = 'removed';
			return out(hit.map((m) => ({ id: m.id, email: m.email })));
		}
		if (t.startsWith('UPDATE member SET data')) {
			const [, id, data, priv, name, city, status] = values as string[];
			const m = members.find((x) => x.id === id)!;
			Object.assign(m, {
				data: JSON.parse(data),
				private_data: JSON.parse(priv),
				name,
				city
			});
			if (status) m.status = status;
			return out([]);
		}
		if (t.startsWith('INSERT INTO audit_event')) {
			const v = values as unknown[];
			audits.push({
				action: v[1],
				targetEmail: v[6],
				before: v[9] && JSON.parse(v[9] as string),
				after: v[10] && JSON.parse(v[10] as string),
				meta: JSON.parse(v[11] as string),
				runId: v[12]
			});
			return out([]);
		}
		throw new Error(`the fake does not know: ${t.slice(0, 80)}`);
	}
};

beforeEach(() => {
	members = [];
	plans = [];
	sql = [];
	audits = [];
});

const csv = (rows: string[][]) => rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
const writes = () =>
	sql.filter((s) => /^\s*(INSERT INTO member |INSERT INTO member\(|UPDATE member)/.test(s.text));

async function previewThenApply(
	text: string,
	mode: 'merge' | 'replace',
	typed: string | null = null
) {
	const p = await previewImport(client, GROUP, ACTOR, { text, mode, confirmPercent: PCT });
	assert.ok(p.ok, JSON.stringify(p));
	assert.ok(p.planId, 'no plan was stored');
	return applyImportPlan(
		client,
		GROUP,
		ACTOR,
		{ planId: p.planId, digest: p.digest, typed, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
}

// ---------------------------------------------------------------------------

test('R15: a full export imported in replace mode writes nothing but the run record', async () => {
	seed(3, [
		{
			email: 'Ada@Example.com',
			data: { name: 'Ada', country: '=1+1', city: '+44' },
			private_data: { phone: "'x" }
		},
		{ email: 'gone@example.com', status: 'removed', data: { name: 'Gone' } }
	]);
	const text = memberCsv(
		members.map((m) => ({
			email: m.email,
			status: m.status,
			data: m.data,
			privateData: m.private_data
		})),
		{ includePrivate: true, includeRemoved: true }
	);
	const before = structuredClone(members);
	const out = await previewThenApply(text, 'replace');
	assert.deepEqual(out, {
		ok: true,
		runId: out.ok ? out.runId : '',
		added: 0,
		changed: 0,
		removed: 0,
		unchanged: 5
	});
	assert.deepEqual(members, before);
	assert.deepEqual(
		audits.map((a) => a.action),
		['members.import']
	);
});

test('R1: merge has no removal statement at all, whatever the file leaves out', async () => {
	seed(10);
	const out = await previewThenApply(
		csv([
			['Email', 'City'],
			['m0@example.com', 'Paris']
		]),
		'merge'
	);
	assert.ok(out.ok && out.removed === 0 && out.changed === 1);
	assert.ok(!sql.some((s) => /status = 'removed'/.test(s.text)), 'merge sent a removal');
	assert.equal(members.filter((m) => m.status === 'active').length, 10);
});

test('R3: a blank email refuses the file and removes nobody, in replace mode too', async () => {
	seed(5);
	const text = csv([
		['Email', 'City'],
		['m0@example.com', 'Paris'],
		['', 'Rome']
	]);
	const p = await previewImport(client, GROUP, ACTOR, {
		text,
		mode: 'replace',
		confirmPercent: PCT
	});
	assert.equal(p.ok, false);
	assert.ok(!p.ok && /1 row has no Email: row 3/.test(p.errors.join()));
	assert.equal(plans.length, 0, 'an invalid file left a plan behind');
	assert.deepEqual(writes(), []);
	assert.ok(members.every((m) => m.status === 'active'));
});

test('R5: removal is the set difference against the file, with no clock and no run state', async () => {
	seed(20);
	const keep = members.slice(0, 19).map((m) => [m.email.toUpperCase()]);
	const out = await previewThenApply(csv([['Email'], ...keep]), 'replace');
	assert.ok(out.ok && out.removed === 1);
	const removal = sql.find((s) => /status = 'removed'/.test(s.text))!;
	assert.match(removal.text, /email <> ALL \(\$2::citext\[\]\)/);
	assert.doesNotMatch(removal.text, /synced_at|started|now\(\)|sync_run/);
	assert.deepEqual(
		(removal.values[1] as string[]).map((e) => e.toLowerCase()),
		members.slice(0, 19).map((m) => m.email)
	);
	assert.deepEqual(
		members.filter((m) => m.status === 'removed').map((m) => m.email),
		['m19@example.com']
	);
	const src = readFileSync(new URL('./member-import.ts', import.meta.url), 'utf8');
	assert.doesNotMatch(src, /sync_run|synced_at|'running'/);
});

test('R6: the apply takes the group lock as its first statement, the same key a profile save takes first', async () => {
	seed(2);
	const p = await previewImport(client, GROUP, ACTOR, {
		text: csv([
			['Email', 'City'],
			['m0@example.com', 'Paris']
		]),
		mode: 'merge',
		confirmPercent: PCT
	});
	assert.ok(p.ok && p.planId);
	sql = [];
	await applyImportPlan(
		client,
		GROUP,
		ACTOR,
		{ planId: p.planId, digest: p.digest, typed: null, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
	assert.equal(sql[0].text, GROUP_LOCK_SQL);
	assert.match(GROUP_LOCK_SQL, /pg_advisory_xact_lock\(/);
	assert.deepEqual(sql[0].values, [GROUP.id]);

	sql = [];
	await runImport(client, GROUP, ACTOR, {
		text: csv([['Email'], ['m0@example.com'], ['m1@example.com']]),
		mode: 'replace',
		apply: false,
		confirmRemovals: null,
		recordPrivateValues: false
	});
	assert.deepEqual(
		sql[0],
		{ text: GROUP_LOCK_SQL, values: [GROUP.id] },
		'the script path locks first too'
	);

	// A profile save goes through updateMemberIn, whose first statement must be
	// this same lock on this same key, or a save and an import run side by side.
	const save: { text: string; values: unknown[] }[] = [];
	const recording = {
		query: async (text: string, values: unknown[] = []) => (
			save.push({ text, values }),
			{ rows: [], rowCount: 0 }
		)
	} as unknown as Client;
	await assert.rejects(() =>
		updateMemberIn(recording, {
			group: GROUP,
			memberId: '00000000-0000-4000-8000-000000000001',
			patch: { city: 'Oslo' },
			actor: ACTOR,
			authority: { admin: true },
			writer: 'form',
			recordPrivateValues: false
		})
	);
	assert.deepEqual(save[0], { text: GROUP_LOCK_SQL, values: [GROUP.id] });
	assert.match(save[1].text, /FOR UPDATE/, 'the save locks before it reads the row');
});

test('R7: apply refuses when the roster moved after the preview, and writes nothing', async () => {
	seed(3);
	const p = await previewImport(client, GROUP, ACTOR, {
		text: csv([
			['Email', 'City'],
			['m0@example.com', 'Paris']
		]),
		mode: 'merge',
		confirmPercent: PCT
	});
	assert.ok(p.ok && p.planId);
	// A profile save lands while the admin reads the preview.
	members[0].data.city = 'Oslo';
	sql = [];
	const out = await applyImportPlan(
		client,
		GROUP,
		ACTOR,
		{ planId: p.planId, digest: p.digest, typed: null, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
	assert.ok(!out.ok && /changed after this preview/.test(out.message));
	assert.deepEqual(writes(), []);
	assert.deepEqual(audits, []);
	assert.equal(members[0].data.city, 'Oslo');
});

test('R7: apply refuses a digest other than the one stored with the plan, and an unknown plan', async () => {
	seed(3);
	const p = await previewImport(client, GROUP, ACTOR, {
		text: csv([
			['Email', 'City'],
			['m0@example.com', 'Paris']
		]),
		mode: 'merge',
		confirmPercent: PCT
	});
	assert.ok(p.ok && p.planId);
	const forged = await applyImportPlan(
		client,
		GROUP,
		ACTOR,
		{ planId: p.planId, digest: 'b'.repeat(64), typed: null, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
	assert.equal(forged.ok, false);
	const other = await applyImportPlan(
		client,
		GROUP,
		{ ...ACTOR, actorSubject: 'email:other@example.com' },
		{ planId: p.planId, digest: p.digest, typed: null, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
	assert.ok(!other.ok && /expired or was already applied/.test(other.message));
	assert.deepEqual(writes(), []);
	// Applied once, the plan is gone and cannot be replayed.
	const first = await applyImportPlan(
		client,
		GROUP,
		ACTOR,
		{ planId: p.planId, digest: p.digest, typed: null, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
	assert.ok(first.ok);
	const again = await applyImportPlan(
		client,
		GROUP,
		ACTOR,
		{ planId: p.planId, digest: p.digest, typed: null, confirmPercent: PCT },
		{ recordPrivateValues: false }
	);
	assert.equal(again.ok, false);
});

test('R8: a small removal proceeds, a large one needs the typed count, a huge one is refused', async () => {
	seed(20);
	const keeping = (n: number) => csv([['Email'], ...members.slice(0, n).map((m) => [m.email])]);

	const small = await previewThenApply(keeping(19), 'replace');
	assert.ok(small.ok && small.removed === 1);

	seed(20);
	const p = await previewImport(client, GROUP, ACTOR, {
		text: keeping(16),
		mode: 'replace',
		confirmPercent: PCT
	});
	assert.ok(p.ok && p.planId && p.gate.kind === 'typed');
	const apply = (typed: string | null) =>
		applyImportPlan(
			client,
			GROUP,
			ACTOR,
			{ planId: p.planId!, digest: p.digest, typed, confirmPercent: PCT },
			{ recordPrivateValues: false }
		);
	const unconfirmed = await apply(null);
	assert.ok(!unconfirmed.ok && /Type 4/.test(unconfirmed.message));
	assert.ok(!(await apply('on')).ok);
	assert.equal(members.filter((m) => m.status === 'removed').length, 0);
	const confirmed = await apply('4');
	assert.ok(confirmed.ok && confirmed.removed === 4);

	seed(20);
	const huge = await previewImport(client, GROUP, ACTOR, {
		text: keeping(9),
		mode: 'replace',
		confirmPercent: PCT
	});
	assert.ok(huge.ok && huge.gate.kind === 'refused' && huge.planId === null);
	assert.equal(plans.length, 0, 'a refused plan was stored');
});

test('R8: the script applies past half only with the exact count, and never an empty file', async () => {
	seed(20);
	const text = csv([['Email'], ...members.slice(0, 5).map((m) => [m.email])]);
	const base = { text, mode: 'replace' as const, apply: true, recordPrivateValues: false };
	const wrong = await runImport(client, GROUP, ACTOR, { ...base, confirmRemovals: 14 });
	assert.ok(!wrong.ok && /--confirm-removals 15/.test(wrong.errors.join()));
	assert.deepEqual(writes(), []);
	const right = await runImport(client, GROUP, ACTOR, { ...base, confirmRemovals: 15 });
	assert.ok(right.ok && right.applied);
	assert.equal(members.filter((m) => m.status === 'active').length, 5);

	const empty = await runImport(client, GROUP, ACTOR, {
		...base,
		text: 'Email\r\n',
		confirmRemovals: 5
	});
	assert.ok(!empty.ok && /no member rows/.test(empty.errors.join()));
});

test('R9: an empty file against a populated group stores no plan and cannot be applied', async () => {
	seed(4);
	for (const mode of ['merge', 'replace'] as const) {
		const p = await previewImport(client, GROUP, ACTOR, {
			text: 'Email,City\r\n',
			mode,
			confirmPercent: 50
		});
		assert.ok(
			p.ok && p.gate.kind === 'refused' && p.gate.reason === 'empty-file' && p.planId === null
		);
	}
	assert.equal(plans.length, 0);
	assert.deepEqual(writes(), []);
});

test('R10: an unknown column is never written, and the roster gains no key from a file', async () => {
	seed(0, [{ email: 'a@example.com', data: { name: 'Ada' } }]);
	const out = await previewThenApply(
		csv([
			['Email', 'Name', 'Favourite Colur'],
			['a@example.com', 'Ada L', 'blue'],
			['new@example.com', 'New', 'red']
		]),
		'merge'
	);
	assert.ok(out.ok && out.added === 1 && out.changed === 1);
	const keys = members.flatMap((m) => [...Object.keys(m.data), ...Object.keys(m.private_data)]);
	assert.deepEqual([...new Set(keys)].sort(), ['name']);
});

test('R2: an empty cell clears a stored field, an absent column leaves it alone', async () => {
	seed(0, [
		{
			email: 'a@example.com',
			data: { name: 'Ada', city: 'Paris' },
			private_data: { phone: '1 Main St' },
			city: 'Paris'
		}
	]);
	const out = await previewThenApply(
		csv([
			['Email', 'City'],
			['a@example.com', '']
		]),
		'merge'
	);
	assert.ok(out.ok && out.changed === 1);
	assert.deepEqual(members[0].data, { name: 'Ada' });
	assert.deepEqual(members[0].private_data, { phone: '1 Main St' });
	assert.equal(members[0].city, null, 'the typed column follows the field it is built from');
});

test('R14: one run event and one event per changed member, joined by the run id, private values redacted', async () => {
	seed(3, [
		{ email: 'a@example.com', data: { name: 'Ada' }, private_data: { phone: '1 Main St' } }
	]);
	const text = csv([
		['Email', 'Name', 'Phone'],
		['a@example.com', 'Ada', '2 High St'],
		['m0@example.com', 'M0', ''],
		['m1@example.com', 'Renamed', ''],
		['m2@example.com', 'M2', ''],
		['new@example.com', 'New', 'secret road']
	]);
	const out = await previewThenApply(text, 'replace');
	assert.ok(out.ok);
	const run = audits.filter((a) => a.action === 'members.import');
	assert.equal(run.length, 1);
	assert.deepEqual(run[0].meta, {
		mode: 'replace',
		channel: 'admin',
		rows: 5,
		added: 1,
		changed: 2,
		removed: 0,
		unchanged: 2,
		digest: (run[0].meta as { digest: string }).digest
	});
	const per = audits.filter((a) => a.action !== 'members.import');
	assert.deepEqual(per.map((a) => [a.action, a.targetEmail]).sort(), [
		['member.import-added', 'new@example.com'],
		['member.import-updated', 'a@example.com'],
		['member.import-updated', 'm1@example.com']
	]);
	const runId = out.ok ? out.runId : '';
	assert.ok(
		audits.every((a) => a.runId === runId),
		'every row carries the run id'
	);
	const a = per.find((x) => x.targetEmail === 'a@example.com')!;
	assert.deepEqual(a.before, { phone: '<set>' });
	assert.deepEqual(a.after, { phone: '<set>' });
	assert.deepEqual(a.meta, { redacted: ['phone'] });
	assert.ok(
		!JSON.stringify(audits).includes('secret road'),
		'a private value reached the audit trail'
	);
	assert.ok(!JSON.stringify(audits).includes('2 High St'));
});

test('R14: a replace removal is recorded per member with how it was removed', async () => {
	seed(10);
	const out = await previewThenApply(
		csv([
			['Email', 'Status'],
			...members.slice(0, 9).map((m, i) => [m.email, i === 0 ? 'removed' : 'active'])
		]),
		'replace',
		'2'
	);
	assert.deepEqual(out.ok && [out.removed, out.unchanged], [2, 8], JSON.stringify(out));
	const removed = audits.filter((a) => a.action === 'member.import-removed');
	assert.deepEqual(removed.map((a) => [a.targetEmail, (a.meta as { via: string }).via]).sort(), [
		['m0@example.com', 'status'],
		['m9@example.com', 'absent']
	]);
});

test('apply rolls back when the removal matches other members than the preview showed', async () => {
	seed(10);
	const p = await previewImport(client, GROUP, ACTOR, {
		text: csv([['Email'], ...members.slice(0, 9).map((m) => [m.email])]),
		mode: 'replace',
		confirmPercent: PCT
	});
	assert.ok(p.ok && p.planId);
	// A member inserted outside the lock's reach (approval does not take it)
	// would be swept by the set difference without appearing in the diff.
	const realQuery = client.query.bind(client);
	const sneaky: Db = {
		async query(text: string, values?: unknown[]) {
			if (/^\s*UPDATE member SET status = 'removed'/.test(text))
				members.push(row('late@example.com'));
			return realQuery(text, values);
		}
	};
	await assert.rejects(
		applyImportPlan(
			sneaky,
			GROUP,
			ACTOR,
			{ planId: p.planId, digest: p.digest, typed: null, confirmPercent: PCT },
			{ recordPrivateValues: false }
		),
		/matched 2 member\(s\) where the preview showed 1/
	);
});

mock.reset();
