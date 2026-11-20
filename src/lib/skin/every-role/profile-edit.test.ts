import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';
import sharp from 'sharp';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// The profile edit and avatar routes where they meet a role the default skin
// has no field for: affiliation checkboxes saved with the text fields, the
// avatar-role field the upload writes, and a name in two parts. The rest is in
// src/routes/group/[slug]/members/[id]/edit/write-path.test.ts.

const read = (p: string) => readFileSync(new URL(`../../../../${p}`, import.meta.url), 'utf8');

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
	data: { givenName: 'Ada', familyName: 'Byron', staff: 'TRUE', publicProfile: 'TRUE' },
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
mock.module('$lib/server/gravatar', { namedExports: { gravatarHash: () => 'h' } });
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

const { load, actions } =
	await import('../../../routes/group/[slug]/members/[id]/edit/+page.server');
const avatar = await import('../../../routes/group/[slug]/members/[id]/avatar/+server');

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

const FORM = { givenName: 'Ada', familyName: 'Byron', aff_staff: 'on', publicProfile: 'on' };

test('R4: a forged checkbox name is refused too, rather than dropped', async () => {
	const res = (await save({ ...FORM, aff_board: 'on' })) as { status: number };
	assert.equal(res.status, 400);
});

test('R3: the text fields and the checkboxes go out in one UPDATE, in one transaction', async () => {
	const res = (await save({ ...FORM, givenName: 'Augusta', aff_volunteer: 'on' })) as {
		status: number;
	};
	assert.equal(res.status, 303);
	const updates = log.filter((t) => /^\s*UPDATE member/.test(t));
	assert.equal(updates.length, 1);
	const data = JSON.parse(params[log.indexOf(updates[0])][2] as string);
	assert.equal(data.givenName, 'Augusta');
	assert.equal(data.volunteer, 'TRUE');
	assert.equal(data.staff, 'TRUE');
	assert.deepEqual(log.slice(0, 1), ['BEGIN']);
	assert.equal(log.at(-1), 'COMMIT');
});

test('R9: the edit page renders from the member row, with no loadError and no sheet read', async () => {
	const page = (await load({ params: routeParams, locals, url } as never)) as Record<
		string,
		unknown
	>;
	assert.ok(!('loadError' in page));
	const fields = page.fields as { name: string; value: string }[];
	assert.equal(fields.find((f) => f.name === 'givenName')?.value, 'Ada');
	assert.equal(fields.find((f) => f.name === 'phone')?.value, '+44 20 7946 0000');
	assert.ok(!fields.some((f) => f.name === 'photo'), 'the photo URL is editable');
	assert.ok(!fields.some((f) => f.name === 'legacyAccess'), 'a retired field is editable');
	assert.doesNotMatch(read('src/routes/group/[slug]/members/[id]/edit/+page.svelte'), /loadError/);
});

test('R7: an upload records the photo URL as the avatar field through the member transaction', async () => {
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
	const i = log.findIndex((t) => /^\s*UPDATE member/.test(t));
	assert.ok(i > 0, 'no member UPDATE');
	const priv = JSON.parse(params[i][3] as string);
	assert.equal(priv.photo, 'https://dir.example.org/avatar/pub-1');
	assert.ok(log.some((t) => /INSERT INTO audit_event/.test(t)));
	assert.equal(log.at(-1), 'COMMIT');
});

test('R7: a failed URL write fails the request instead of reporting success', async () => {
	failWrites = true;
	lockedRow!.private_data = { photo: 'https://dir.example.org/avatar/pub-1' };
	await assert.rejects(
		async () => avatar.DELETE({ params: routeParams, locals, url } as never),
		/db down/
	);
	const src = read('src/routes/group/[slug]/members/[id]/avatar/+server.ts');
	assert.doesNotMatch(src, /mirrorBioPic|writeMemberCells|BIO_PIC_HEADER/);
	assert.doesNotMatch(
		read('src/lib/server/member-edit.ts'),
		/sheet-rw|writeMemberCells|deleteMemberRow/
	);
});

test('R4: a refused save echoes only rendered fields, so a __proto__ name cannot fail serialization', async () => {
	const res = (await save({ ...FORM, givenName: 'Augusta', ['__proto__']: 'x' })) as {
		status: number;
		data: { values: Record<string, string> };
	};
	assert.equal(res.status, 400);
	assert.equal(Object.getPrototypeOf(res.data.values), Object.prototype);
	assert.deepEqual(Object.keys(res.data.values).sort(), ['familyName', 'givenName']);
	assert.equal(res.data.values.givenName, 'Augusta');
});
