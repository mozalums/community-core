import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { parseCsv } from '$lib/server/csv-core';

// The endpoint's own behavior once the guard has let an admin through: which
// variant the query string picks, what the response is called, and that a
// private export leaves an audit row inside the same transaction as the read.

const GROUP = { id: 'g-1', slug: 'example' };
const ROWS = [
	{
		email: 'ada@example.com',
		status: 'active',
		data: { name: 'Ada', bio: 'one\ntwo' },
		private_data: { phone: '12 St James Sq' }
	},
	{ email: 'gone@example.com', status: 'removed', data: { name: 'Gone' }, private_data: {} }
];

const sql: string[] = [];
const audited: { inTx: boolean; entry: Record<string, unknown> }[] = [];
let inTx = false;

const client = {
	query: async (text: string) => {
		sql.push(text);
		const active = /status = 'active'/.test(text);
		const priv = !/'\{\}' AS private_data/.test(text);
		// The loader selects both bags as jsonb text.
		return {
			rows: ROWS.filter((r) => !active || r.status === 'active').map((r) => ({
				...r,
				data: JSON.stringify(r.data),
				private_data: priv ? JSON.stringify(r.private_data) : '{}'
			}))
		};
	}
};

mock.module('$lib/server/route-guards', {
	namedExports: { requireGroupAdmin: async () => GROUP }
});
mock.module('$lib/server/postgres', {
	namedExports: {
		withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
			inTx = true;
			try {
				return await fn(client);
			} finally {
				inTx = false;
			}
		}
	}
});
mock.module('$lib/server/audit', {
	namedExports: {
		actorOf: (u: { subject: string; email: string }) => ({
			actorSubject: u.subject,
			actorEmail: u.email
		}),
		auditIn: async (_c: unknown, entry: Record<string, unknown>) => {
			audited.push({ inTx, entry });
		}
	}
});

const { GET } = await import('./+server');

async function get(query: string) {
	sql.length = 0;
	audited.length = 0;
	const url = new URL(`http://localhost/admin/export${query}`);
	const res: Response = await GET({
		params: { slug: GROUP.slug },
		locals: { user: { subject: 'email:admin@example.com', email: 'admin@example.com' } },
		url
	} as never);
	// Response.text() drops a leading BOM while decoding, so read the bytes
	// Excel will read.
	const bytes = new Uint8Array(await res.arrayBuffer());
	return { res, bytes, text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) };
}

test('R3: the default export is active members, no private column, no audit row', async () => {
	const { res, bytes, text } = await get('');
	assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
	assert.match(
		res.headers.get('content-disposition')!,
		/^attachment; filename="example-members-\d{4}-\d\d-\d\d\.csv"$/
	);
	assert.match(res.headers.get('cache-control')!, /no-store/);
	assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'R5: the body opens with a BOM');
	const rows = parseCsv(text);
	assert.equal(rows.length, 2);
	assert.ok(!rows[0].includes('Phone'));
	assert.match(sql[0], /'\{\}' AS private_data/, 'private_data is never selected');
	assert.equal(audited.length, 0);
	// The sign-in address leads, then the fields in schema order.
	assert.deepEqual(rows[0].slice(0, 2), ['Email', 'Name']);
	assert.deepEqual(rows[1].slice(0, 2), ['ada@example.com', 'Ada']);
	assert.equal(rows[1][rows[0].indexOf('Bio')], 'one\ntwo', 'R6: the multiline bio survives');
});

test('R3: ?private=1 adds the private columns, renames the file and audits in the transaction', async () => {
	const { res, text } = await get('?private=1');
	assert.match(
		res.headers.get('content-disposition')!,
		/filename="example-members-PRIVATE-\d{4}-\d\d-\d\d\.csv"/
	);
	const [head, ada] = parseCsv(text);
	assert.equal(ada[head.indexOf('Phone')], '12 St James Sq');
	assert.equal(audited.length, 1);
	assert.equal(audited[0].inTx, true, 'the audit row commits with the read or not at all');
	assert.equal(audited[0].entry.action, 'members.export-private');
	assert.equal(audited[0].entry.actorSubject, 'email:admin@example.com');
	assert.deepEqual(audited[0].entry.meta, { privateFields: true, includeRemoved: false, rows: 1 });
});

test('R3: ?removed=1 adds removed members and a Status column', async () => {
	const { res, text } = await get('?removed=1');
	assert.match(res.headers.get('content-disposition')!, /members-with-removed-/);
	const rows = parseCsv(text);
	assert.equal(rows[0].at(-1), 'Status');
	assert.deepEqual(
		rows.slice(1).map((r) => r.at(-1)),
		['active', 'removed']
	);
	assert.equal(audited.length, 0);
});
