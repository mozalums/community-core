// Test double for the statements requests.ts sends: access_request and member
// as in-memory rows, with the two properties the code leans on modeled rather
// than assumed. The partial unique index means "one pending row per address";
// FOR UPDATE means a second transaction selecting the same row waits for the
// first to finish. A transaction that throws restores the rows it started with.
//
// requests.pg.test.ts runs the same flows against real Postgres when a database
// is named; this exists so the gate exercises them without one.

import { AUDIT_INSERT_SQL } from './audit-core';

export type FakeRequest = {
	id: string;
	group_id: string;
	email: string;
	ident_subject: string | null;
	name: string | null;
	data: Record<string, string>;
	status: 'pending' | 'approved' | 'denied';
	decided_at: string | null;
	decided_by: string | null;
	deny_reason: string | null;
	created_at: number;
};

export type FakeMember = {
	id: string;
	group_id: string;
	email: string;
	name: string | null;
	city: string | null;
	linkedin: string | null;
	data: Record<string, string>;
	private_data: Record<string, string>;
	status: string;
};

export type FakeRequestDb = {
	requests: FakeRequest[];
	members: FakeMember[];
	audits: unknown[][];
	statements: string[];
	query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
	withTransaction: <T>(fn: (client: unknown) => Promise<T>) => Promise<T>;
	reset: () => void;
};

const lower = (v: unknown) => String(v).toLowerCase();

export function fakeRequestDb(): FakeRequestDb {
	let seq = 0;
	const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
	const locks = new Map<string, Promise<void>>();

	const db: FakeRequestDb = {
		requests: [],
		members: [],
		audits: [],
		statements: [],
		reset() {
			db.requests.length = 0;
			db.members.length = 0;
			db.audits.length = 0;
			db.statements.length = 0;
		},
		query: (text, values) => run(text, values ?? [], null),
		async withTransaction(fn) {
			const held: (() => void)[] = [];
			const snapshot = structuredClone({ r: db.requests, m: db.members, a: db.audits });
			const client = {
				query: (text: string, values?: unknown[]) => run(text, values ?? [], held)
			};
			try {
				return await fn(client);
			} catch (e) {
				db.requests.splice(0, db.requests.length, ...snapshot.r);
				db.members.splice(0, db.members.length, ...snapshot.m);
				db.audits.splice(0, db.audits.length, ...snapshot.a);
				throw e;
			} finally {
				for (const release of held) release();
			}
		}
	};

	async function lock(id: string, held: (() => void)[] | null): Promise<void> {
		while (locks.has(id)) await locks.get(id);
		let release!: () => void;
		locks.set(
			id,
			new Promise<void>((r) => {
				release = () => {
					locks.delete(id);
					r();
				};
			})
		);
		held?.push(release);
	}

	async function run(text: string, v: unknown[], held: (() => void)[] | null) {
		db.statements.push(text);
		const ok = (rows: unknown[]) => ({ rows, rowCount: rows.length });
		// Yield, so two transactions started together really interleave.
		await Promise.resolve();

		if (text === AUDIT_INSERT_SQL) {
			db.audits.push(v);
			return ok([]);
		}
		// The member-write group lock. Row-level ordering is what these tests
		// exercise, through the access_request lock below.
		if (/pg_advisory_xact_lock/.test(text)) return ok([]);
		if (/INSERT INTO access_request/.test(text)) {
			const [group_id, email, ident_subject, name, data] = v as string[];
			const hit = db.requests.find(
				(r) => r.group_id === group_id && lower(r.email) === lower(email) && r.status === 'pending'
			);
			if (hit) {
				Object.assign(hit, { ident_subject, name, data: JSON.parse(data) });
				return ok([{ id: hit.id, inserted: false }]);
			}
			const row: FakeRequest = {
				id: nextId(),
				group_id,
				email,
				ident_subject,
				name,
				data: JSON.parse(data),
				status: 'pending',
				decided_at: null,
				decided_by: null,
				deny_reason: null,
				created_at: seq
			};
			db.requests.push(row);
			return ok([{ id: row.id, inserted: true }]);
		}
		if (
			/FROM access_request\s+WHERE id = \$1 AND group_id = \$2 AND status = 'pending'\s+FOR UPDATE/.test(
				text
			)
		) {
			const [id, group_id] = v as string[];
			await lock(id, held);
			const r = db.requests.find(
				(x) => x.id === id && x.group_id === group_id && x.status === 'pending'
			);
			return ok(r ? [{ email: r.email, data: structuredClone(r.data) }] : []);
		}
		if (/INSERT INTO member/.test(text)) {
			const [group_id, email, name, city, linkedin, data, private_data] = v as string[];
			const hit = db.members.find(
				(m) => m.group_id === group_id && lower(m.email) === lower(email)
			);
			const fields = {
				name,
				city,
				linkedin,
				data: JSON.parse(data),
				private_data: JSON.parse(private_data),
				status: 'active'
			};
			if (!hit) {
				const m = { id: nextId(), group_id, email, ...fields };
				db.members.push(m);
				return ok([{ id: m.id }]);
			}
			if (hit.status === 'active') return ok([]);
			Object.assign(hit, fields);
			return ok([{ id: hit.id }]);
		}
		if (/SET status = 'approved'/.test(text)) {
			const r = db.requests.find((x) => x.id === v[0]);
			if (r) Object.assign(r, { status: 'approved', decided_at: 'now', decided_by: v[1] });
			return ok([]);
		}
		if (/SET status = 'denied'/.test(text)) {
			const [id, group_id, by, reason] = v as (string | null)[];
			await lock(String(id), held);
			const r = db.requests.find(
				(x) => x.id === id && x.group_id === group_id && x.status === 'pending'
			);
			if (!r) return ok([]);
			Object.assign(r, {
				status: 'denied',
				decided_at: new Date(1_800_000_000_000 + r.created_at).toISOString(),
				decided_by: by,
				deny_reason: reason
			});
			return ok([{ email: r.email }]);
		}
		if (/FROM access_request r/.test(text)) {
			const pending = db.requests
				.filter((r) => r.group_id === v[0] && r.status === 'pending')
				.sort((a, b) => a.created_at - b.created_at);
			return ok(
				pending.map((r) => ({
					id: r.id,
					email: r.email,
					name: r.name,
					data: r.data,
					denials: db.requests
						.filter(
							(d) =>
								d.group_id === r.group_id &&
								lower(d.email) === lower(r.email) &&
								d.status === 'denied'
						)
						.sort((a, b) => b.created_at - a.created_at)
						.map((d) => ({ at: d.decided_at, reason: d.deny_reason }))
				}))
			);
		}
		throw new Error(`requests-fake: unexpected statement: ${text}`);
	}

	return db;
}
