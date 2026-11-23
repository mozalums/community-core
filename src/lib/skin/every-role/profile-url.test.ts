import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createServer, type ViteDevServer } from 'vite';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// A url-typed field (`website`) through the profile save, the editor, the
// profile page and the admin requests page. The default skin has no url field,
// so this runs on every role's fields.

const GROUP = { id: '00000000-0000-4000-8000-000000000001', slug: 'example', name: 'Example' };
const ID = '00000000-0000-4000-8000-0000000000aa';
const ADA = { id: 'u', email: 'ada@example.org', subject: 'oidc:ada', name: 'Ada', image: '' };
const EVIL = 'javascript:alert(1)';

let member: Record<string, unknown>;
let pending: Record<string, unknown>[] = [];
let log: string[] = [];
let params: unknown[][] = [];

const client = {
	query: async (text: string, values: unknown[] = []) => {
		log.push(text);
		params.push(values);
		if (/FOR UPDATE/.test(text)) {
			return {
				rows: [
					{
						email: member.email,
						ident_subject: member.identSubject,
						data: structuredClone(member.data),
						private_data: structuredClone(member.privateData),
						name: member.name,
						city: null
					}
				],
				rowCount: 1
			};
		}
		return { rows: [], rowCount: 1 };
	}
};

mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (text: string) => {
			log.push(text);
			return /FROM access_request/.test(text)
				? { rows: structuredClone(pending), rowCount: pending.length }
				: { rows: [], rowCount: 0 };
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
		getMemberById: async () => structuredClone(member),
		canEditMember: (m: { identSubject: string }, u: typeof ADA | null, admin: boolean) =>
			admin || (!!u && u.subject === m.identSubject)
	}
});
mock.module('$lib/server/avatars', {
	namedExports: { avatarIdFor: async () => null, deleteAvatar: async () => {} }
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
mock.module('$lib/server/email', {
	namedExports: { sendMembershipApprovedEmail: async () => {} }
});
mock.module('$lib/server/audit', { namedExports: { actorOf: () => ({}) } });
mock.module('$lib/server/route-guards', { namedExports: { requireGroupAdmin: async () => GROUP } });

const edit = await import('../../../routes/group/[slug]/members/[id]/edit/+page.server');
const profile = await import('../../../routes/group/[slug]/members/[id]/+page.server');
const requests = await import('../../../routes/group/[slug]/admin/requests/+page.server');

beforeEach(() => {
	log = [];
	params = [];
	pending = [];
	member = {
		id: ID,
		groupId: GROUP.id,
		email: 'ada@example.org',
		identSubject: 'oidc:ada',
		name: 'Ada Byron',
		city: null,
		status: 'active',
		data: { givenName: 'Ada', familyName: 'Byron', staff: 'TRUE', publicProfile: 'TRUE' },
		privateData: {}
	};
});

let vite: ViteDevServer | null = null;
after(async () => {
	await vite?.close();
});
async function render(route: string, props: Record<string, unknown>): Promise<string> {
	vite ??= await createServer({
		server: { middlewareMode: true, watch: null, hmr: false },
		appType: 'custom',
		logLevel: 'silent'
	});
	const { default: Page } = await vite.ssrLoadModule(route);
	const { render } = await vite.ssrLoadModule('svelte/server');
	const store = <T>(value: T) => ({
		subscribe(fn: (v: T) => void) {
			fn(value);
			return () => {};
		}
	});
	const context = new Map([
		[
			'__svelte__',
			{
				page: store({
					url: new URL(`http://localhost/group/example/members/${ID}`),
					params: { id: ID, slug: 'example' }
				}),
				navigating: store(null),
				updated: store(false)
			}
		]
	]);
	return render(Page, { props, context }).body;
}

const routeParams = { slug: 'example', id: ID };
const url = new URL(`https://dir.example.org/group/example/members/${ID}/edit`);
const locals = { user: ADA } as unknown as App.Locals;
const FORM = { givenName: 'Ada', familyName: 'Byron', aff_staff: 'on', publicProfile: 'on' };

async function save(fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.append(k, v);
	const request = new Request(url, { method: 'POST', body });
	try {
		return await edit.actions.save({ request, params: routeParams, locals, url } as never);
	} catch (e) {
		return e;
	}
}

const anchors = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

test('B30 4: a javascript: URL through the save action is a 400 naming the field, and nothing is written', async () => {
	const res = (await save({ ...FORM, website: EVIL })) as {
		status: number;
		data: { error: string; fieldError: { name: string; message: string } };
	};
	assert.equal(res.status, 400);
	assert.equal(res.data.fieldError.name, 'website');
	assert.equal(res.data.fieldError.message, 'Website must start with https://');
	assert.match(res.data.error, /Website must start with https:\/\//);
	assert.ok(!log.some((t) => /^\s*UPDATE member/.test(t)), 'the member row was written');
	assert.equal(log.at(-1), 'ROLLBACK');
});

test('a bare address saves with https:// prepended', async () => {
	const res = (await save({ ...FORM, website: 'linkedin.com/in/ada' })) as { status: number };
	assert.equal(res.status, 303);
	const i = log.findIndex((t) => /^\s*UPDATE member/.test(t));
	assert.ok(i > 0, 'no member UPDATE');
	assert.equal(JSON.parse(params[i][2] as string).website, 'https://linkedin.com/in/ada');
});

test('B30 1: an empty value still clears the field', async () => {
	(member.data as Record<string, string>).website = 'https://linkedin.com/in/ada';
	const res = (await save({ ...FORM, website: '' })) as { status: number };
	assert.equal(res.status, 303);
	const i = log.findIndex((t) => /^\s*UPDATE member/.test(t));
	assert.ok(!('website' in JSON.parse(params[i][2] as string)));
});

test('a save that omits the URL field leaves it as it was', async () => {
	(member.data as Record<string, string>).website = EVIL;
	const res = (await save({ ...FORM, givenName: 'Augusta' })) as { status: number };
	assert.equal(res.status, 303);
	const i = log.findIndex((t) => /^\s*UPDATE member/.test(t));
	assert.ok(i > 0, 'no member UPDATE');
	assert.equal(JSON.parse(params[i][2] as string).website, EVIL);
});

test('resaving a legacy URL that only trims to the checked value replaces it', async () => {
	const good = 'https://example.org/ada';
	for (const other of [{}, { givenName: 'Augusta' }]) {
		log = [];
		params = [];
		(member.data as Record<string, string>).website = ' ' + good;
		const res = (await save({ ...FORM, ...other, website: good })) as { status: number };
		assert.equal(res.status, 303);
		const i = log.findIndex((t) => /^\s*UPDATE member/.test(t));
		assert.ok(i > 0, `no member UPDATE (${JSON.stringify(other)})`);
		assert.equal(JSON.parse(params[i][2] as string).website, good);
	}
});

test('B30 1: resaving an already normalized URL writes nothing', async () => {
	const good = 'https://example.org/ada';
	(member.data as Record<string, string>).website = good;
	const res = (await save({ ...FORM, website: good })) as { status: number };
	assert.equal(res.status, 303);
	assert.ok(!log.some((t) => /^\s*UPDATE member/.test(t)), 'a no-op save wrote the row');
});

test('B30 2: the editor offers a url field as a URL input, and shows the 400 beside it', async () => {
	const data = (await edit.load({ params: routeParams, locals, url } as never)) as Record<
		string,
		unknown
	>;
	const page = { ...data, group: { slug: 'example', name: 'Example' } };
	const clean = await render('/src/routes/group/[slug]/members/[id]/edit/+page.svelte', {
		data: page,
		form: null
	});
	const input = clean.match(/<input\b[^>]*\bname="website"[^>]*>/)?.[0] ?? '';
	assert.match(input, /\btype="url"/);
	assert.match(input, /\binputmode="url"/);
	assert.match(input, /\bautocomplete="url"/);
	assert.doesNotMatch(clean, /id="f-website-error"/);

	const refused = (await save({ ...FORM, website: EVIL })) as { data: Record<string, unknown> };
	const body = await render('/src/routes/group/[slug]/members/[id]/edit/+page.svelte', {
		data: page,
		form: refused.data
	});
	const after = body.match(/<input\b[^>]*\bname="website"[^>]*>/)?.[0] ?? '';
	assert.match(after, /aria-invalid="true"/);
	assert.match(after, /aria-describedby="f-website-error"/);
	const note = body.match(/<p id="f-website-error"[^>]*>([\s\S]*?)<\/p>/);
	assert.ok(note, 'no message beside the field');
	assert.match(note[1], /Website must start with https:\/\//);
	// Beside the control: after the input, before the next field's label.
	const at = body.indexOf(after);
	assert.ok(body.indexOf('id="f-website-error"') > at);
	assert.ok(body.indexOf('id="f-website-error"') < body.indexOf('<label', at));
});

test('B30 2: a bare stored or echoed value renders with its scheme, so the browser lets the form post', async () => {
	const data = (await edit.load({ params: routeParams, locals, url } as never)) as {
		fields: { name: string; value: string }[];
	};
	const fields = data.fields.map((f) =>
		f.name === 'website' ? { ...f, value: 'linkedin.com/in/ada' } : f
	);
	const page = { ...data, fields, group: { slug: 'example', name: 'Example' } };
	const value = (html: string) =>
		html.match(/<input\b[^>]*\bname="website"[^>]*\bvalue="([^"]*)"/)?.[1];
	const route = '/src/routes/group/[slug]/members/[id]/edit/+page.svelte';
	assert.equal(
		value(await render(route, { data: page, form: null })),
		'https://linkedin.com/in/ada'
	);
	const echoed = { error: 'x', values: { website: 'example.org/ada' } };
	assert.equal(value(await render(route, { data: page, form: echoed })), 'https://example.org/ada');
	const scheme = { error: 'x', values: { website: 'http://example.org/ada' } };
	assert.equal(value(await render(route, { data: page, form: scheme })), 'http://example.org/ada');
});

async function viewProfile() {
	const data = await profile.load({
		params: routeParams,
		locals: { user: { subject: 's', email: 'viewer@example.org' } },
		parent: async () => ({ isGroupAdmin: false })
	} as never);
	return render('/src/routes/group/[slug]/members/[id]/+page.svelte', {
		data: { ...(data as object), group: { slug: 'example', name: 'Example' } }
	});
}

test('B30 4: a stored javascript: value renders as text and reaches no anchor', async () => {
	(member.data as Record<string, string>).website = EVIL;
	const body = await viewProfile();
	assert.ok(body.includes('javascript:alert(1)'), 'the value is not shown at all');
	for (const a of anchors(body)) assert.doesNotMatch(a, /javascript:/i, a);
});

test('B30 3: an http:// value written before the fix renders as text, an https one as a link', async () => {
	(member.data as Record<string, string>).website = 'http://example.org/ada';
	let body = await viewProfile();
	assert.ok(!anchors(body).some((a) => a.includes('example.org/ada')));
	assert.ok(body.includes('http://example.org/ada'));

	(member.data as Record<string, string>).website = 'https://example.org/ada';
	body = await viewProfile();
	assert.ok(
		anchors(body).some(
			(a) => a.includes('href="https://example.org/ada"') && a.includes('noopener noreferrer')
		)
	);
});

test('B30 3: the admin requests page links a request URL only where the save check passes', async () => {
	const row = (id: string, website: string) => ({
		id,
		email: `${id}@example.org`,
		name: 'Nomi',
		data: { givenName: 'Nomi', website },
		denials: []
	});
	pending = [
		row('00000000-0000-4000-8000-000000000101', EVIL),
		row('00000000-0000-4000-8000-000000000102', 'http://example.org/nomi'),
		row('00000000-0000-4000-8000-000000000103', 'https://example.org/ok')
	];
	const data = await requests.load({ params: { slug: 'example' } } as never);
	const body = await render('/src/routes/group/[slug]/admin/requests/+page.svelte', {
		data: { ...(data as object), group: { slug: 'example', name: 'Example' } },
		form: null
	});
	const links = anchors(body);
	assert.ok(!links.some((a) => /javascript:|http:\/\/example/.test(a)), links.join('\n'));
	assert.ok(links.some((a) => a.includes('href="https://example.org/ok"')));
	assert.ok(body.includes('http://example.org/nomi'));
});
