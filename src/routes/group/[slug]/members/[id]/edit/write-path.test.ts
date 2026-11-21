import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';
import sharp from 'sharp';

// The profile routes over the real member-write path, with Postgres replaced
// by a client that records statements and the Sheets API wired to fail the
// test if anything reaches it. It runs on the default skin; the affiliation
// checkboxes and the avatar-role field are in
// src/lib/skin/every-role/profile-edit.test.ts.

const read = (p: string) =>
	readFileSync(new URL(`../../../../../../../${p}`, import.meta.url), 'utf8');

const GROUP = { id: '00000000-0000-4000-8000-000000000001', slug: 'example', name: 'Example' };
const ID = '00000000-0000-4000-8000-0000000000aa';
const ADA = { id: 'u', email: 'ada@example.org', subject: 'oidc:ada', name: 'Ada', image: '' };
const MEMBER = {
	id: ID,
	groupId: GROUP.id,
	email: 'ada@example.org',
	identSubject: 'oidc:ada',
	name: 'Ada Byron',
	city: null,
	linkedin: null,
	status: 'active',
	data: { name: 'Ada Byron', country: 'UK' },
	privateData: { phone: '+44 20 7946 0000' }
};

let log: string[] = [];
let params: unknown[][] = [];
let lockedRow: Record<string, unknown> | null = null;
let failWrites = false;
let stored: { bytes: number }[] = [];

const client = {
	query: async (text: string, values: unknown[] = []) => {
		log.push(text);
		params.push(values);
		if (failWrites && /^\s*UPDATE member/.test(text)) throw new Error('db down');
		if (/FOR UPDATE/.test(text) || /^\s*DELETE FROM member/.test(text)) {
			return { rows: lockedRow ? [structuredClone(lockedRow)] : [], rowCount: lockedRow ? 1 : 0 };
		}
		return { rows: [], rowCount: 1 };
	}
};

mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string) => {
			log.push(text);
			return { rows: [], rowCount: 0 };
		},
		withTransaction: async (fn: (c: typeof client) => Promise<unknown>) => {
			log.push('BEGIN');
			params.push([]);
			try {
				const out = await fn(client);
				log.push('COMMIT');
				params.push([]);
				return out;
			} catch (e) {
				log.push('ROLLBACK');
				params.push([]);
				throw e;
			}
		}
	}
});
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/members', {
	namedExports: {
		getMemberById: async () => structuredClone(MEMBER),
		canEditMember: (m: typeof MEMBER, u: typeof ADA | null, admin: boolean) =>
			admin || (!!u && u.subject === m.identSubject)
	}
});
mock.module('$lib/server/avatars', {
	namedExports: {
		avatarIdFor: async () => null,
		deleteAvatar: async () => {},
		putAvatar: async (_e: string, b: Buffer) => {
			stored.push({ bytes: b.length });
			return 'pub-1';
		},
		ACCEPTED_TYPES: ['image/png'],
		MAX_AVATAR_BYTES: 1024
	}
});
mock.module('$lib/server/session-store', {
	namedExports: {
		deleteSession: async () => {},
		deleteUserSessions: async () => {},
		SESSION_COOKIE_NAME: 'sid',
		SESSION_COOKIE_OPTIONS: {}
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { load, actions } = await import('./+page.server');
const avatar = await import('../avatar/+server');

beforeEach(() => {
	log = [];
	params = [];
	failWrites = false;
	stored = [];
	lockedRow = {
		email: MEMBER.email,
		ident_subject: MEMBER.identSubject,
		data: structuredClone(MEMBER.data),
		private_data: structuredClone(MEMBER.privateData),
		name: MEMBER.name,
		city: null,
		linkedin: null
	};
});

const routeParams = { slug: 'example', id: ID };
const url = new URL(`https://dir.example.org/group/example/members/${ID}/edit`);
const locals = { user: ADA } as unknown as App.Locals;

function post(fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	return new Request(url, { method: 'POST', body });
}

async function save(fields: Record<string, string>) {
	try {
		return await actions.save({ request: post(fields), params: routeParams, locals, url } as never);
	} catch (e) {
		return e;
	}
}

const FORM = { name: 'Ada Byron', country: 'UK' };

test('R4: a form field the schema does not know is a 400, with nothing written', async () => {
	const res = (await save({ ...FORM, 'Photo URL': 'https://evil.example/x.png' })) as {
		status: number;
		data: { error: string };
	};
	assert.equal(res.status, 400);
	assert.match(res.data.error, /unknown field "Photo URL"/);
	assert.ok(!log.some((t) => /^\s*UPDATE member/.test(t)));
	assert.equal(log.at(-1), 'ROLLBACK');
});

test('R4: a forged checkbox name is refused too, rather than dropped', async () => {
	const res = (await save({ ...FORM, aff_staff: 'on' })) as { status: number };
	assert.equal(res.status, 400);
});

test('R9: the edit page renders from the member row, with no loadError and no sheet read', async () => {
	const page = (await load({ params: routeParams, locals, url } as never)) as Record<
		string,
		unknown
	>;
	assert.ok(!('loadError' in page));
	const fields = page.fields as { name: string; value: string }[];
	assert.deepEqual(
		fields.map((f) => [f.name, f.value]),
		[
			['name', 'Ada Byron'],
			['country', 'UK'],
			['city', ''],
			['bio', ''],
			['phone', '+44 20 7946 0000']
		]
	);
	assert.doesNotMatch(read('src/routes/group/[slug]/members/[id]/edit/+page.svelte'), /loadError/);
});

test('R8: deleting a profile runs one purge transaction and never reaches the sheet', async () => {
	const cookies = { get: () => undefined, delete: () => {} };
	await assert.rejects(
		async () => actions.delete({ params: routeParams, locals, url, cookies } as never),
		(r: unknown) => (r as { status: number }).status === 303
	);
	const tx = log.slice(log.indexOf('BEGIN'), log.indexOf('COMMIT') + 1);
	assert.match(tx[1], /pg_advisory_xact_lock/);
	assert.match(tx[2], /DELETE FROM member/);
	assert.match(tx[3], /INSERT INTO audit_event/);
	const src = read('src/routes/group/[slug]/members/[id]/edit/+page.server.ts');
	assert.doesNotMatch(src, /deleteMemberRow|shiftSourceRows|sheet-rw/);
	assert.match(src, /with the\s+(\/\/ )?sheet step gone that question no longer arises/);
});

test('R7: with no avatar-role field an upload is stored and the member row is left alone', async () => {
	const body = new FormData();
	const png = await sharp({
		create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 0 } }
	})
		.png()
		.toBuffer();
	body.append('photo', new File([new Uint8Array(png)], 'a.png', { type: 'image/png' }));
	const req = new Request(url, { method: 'POST', body });
	const res = await avatar.POST({ params: routeParams, locals, request: req, url } as never);
	assert.equal(res.status, 200);
	assert.equal(stored.length, 1);
	assert.ok(!log.some((t) => /^\s*UPDATE member|^BEGIN$/.test(t)), 'the member row was written');
});

test('R5: the member, not an admin, saves their own private field and it commits', async () => {
	const res = (await save({ ...FORM, phone: '555 0100' })) as { status: number };
	assert.equal(res.status, 303);
	const i = log.findIndex((t) => /^\s*UPDATE member/.test(t));
	assert.ok(i > 0, 'no member UPDATE');
	assert.equal(JSON.parse(params[i][3] as string).phone, '555 0100');
	assert.equal(log.at(-1), 'COMMIT');
});

test('R4: a refused save echoes only rendered fields, so a __proto__ name cannot fail serialization', async () => {
	const res = (await save({ ...FORM, name: 'Augusta', ['__proto__']: 'x' })) as {
		status: number;
		data: { values: Record<string, string> };
	};
	assert.equal(res.status, 400);
	assert.equal(Object.getPrototypeOf(res.data.values), Object.prototype);
	assert.deepEqual(Object.keys(res.data.values).sort(), ['country', 'name']);
	assert.equal(res.data.values.name, 'Augusta');
});

for (const key of ['__proto__', 'aff___proto__']) {
	test(`review R4: unknown form key ${key} reaches validation`, async () => {
		const res = (await save({ ...FORM, name: 'Augusta', [key]: 'unexpected' })) as {
			status: number;
		};
		assert.equal(res.status, 400);
		assert.ok(!log.some((t) => /^\s*UPDATE member/.test(t)));
	});
}
