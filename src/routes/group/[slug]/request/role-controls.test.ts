import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, mock, test } from 'node:test';
import { fieldSchemaWith } from '$lib/server/field-schema-fake';
import { fakeRequestDb } from '$lib/server/requests-fake';
import { ROLE_CONTROLS, type SkinField } from '$lib/skin/schema';

// The property: a fixed form control is bound to its field by role. The key a
// skin gives that field decides where the value is stored, and where the skin
// lists it decides the order it is shown and joined in; neither decides which
// control's value it receives. So this field set is everything the forms could
// have assumed, turned around: the family name listed before the given name,
// and no key spelled like the control that posts to it.
const RENAMED_FIELDS: readonly SkinField[] = [
	{
		key: 'surname',
		label: 'Family name',
		type: 'text',
		visibility: 'members',
		role: 'familyName',
		column: 'name'
	},
	{
		key: 'forename',
		label: 'Given name',
		type: 'text',
		visibility: 'members',
		role: 'givenName',
		column: 'name'
	},
	{
		key: 'workProfile',
		label: 'Work profile',
		type: 'url',
		visibility: 'members',
		column: 'linkedin'
	},
	{ key: 'crew', label: 'Crew', type: 'checkbox', visibility: 'members', role: 'affiliation' },
	{
		key: 'otherGroups',
		label: 'Other groups',
		type: 'text',
		visibility: 'members',
		role: 'affiliationOther'
	},
	{
		key: 'showOnHome',
		label: 'Public profile',
		type: 'checkbox',
		visibility: 'members',
		role: 'publicProfile'
	},
	{ key: 'about', label: 'About', type: 'longtext', visibility: 'members', role: 'bio' },
	{ key: 'phone', label: 'Phone', type: 'text', visibility: 'private' }
];

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(RENAMED_FIELDS) });

const GROUP = {
	id: '00000000-0000-4000-8000-0000000000f1',
	slug: 'example',
	name: 'Example Community'
};
const EMAIL = 'nomi@example.org';
const db = fakeRequestDb();
const notices: { label: string; value: string }[][] = [];

mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => GROUP } });
mock.module('$lib/server/email', {
	namedExports: {
		sendMembershipRequestNotice: async (n: { rows: { label: string; value: string }[] }) => {
			notices.push(n.rows);
			return true;
		}
	}
});
mock.module('$lib/server/rate-limit', {
	namedExports: {
		rateLimitKey: (bucket: string, id: string) => `${bucket}:${id}`,
		hashId: (s: string) => s,
		rateLimited: async () => false
	}
});
mock.module('$lib/server/postgres', {
	namedExports: {
		query: db.query,
		withTransaction: db.withTransaction,
		pgPool: () => assert.fail('no pool expected here')
	}
});

const { actions, load } = await import('./+page.server');
const { approveRequest, listRequests } = await import('$lib/server/requests');
const { choiceEcho, formEcho, formUpdate, profilePatch, readAffiliations, readEditFields } =
	await import('$lib/server/member-edit');
const { MemberWriteError, validatePatch } = await import('$lib/server/member-write-core');

const url = new URL('https://www.example.org/group/example/request');

function formOf(entries: Record<string, string>): FormData {
	const form = new FormData();
	for (const [k, v] of Object.entries(entries)) form.set(k, v);
	return form;
}

const post = (entries: Record<string, string>) =>
	actions.default({
		request: new Request(url, { method: 'POST', body: formOf(entries) }),
		url,
		params: { slug: 'example' },
		locals: { user: { email: EMAIL, subject: `email:${EMAIL}` } }
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any) as Promise<any>;

beforeEach(() => {
	db.reset();
	notices.length = 0;
});

test('R6: the request form shows the name controls in the skin’s order, each bound by role', async () => {
	const data = (await load({
		parent: async () => ({ member: null, isGroupAdmin: false }),
		params: { slug: 'example' },
		locals: { user: { email: EMAIL, subject: `email:${EMAIL}`, name: 'Nomi Vance' } },
		url
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any)) as any;
	assert.deepEqual(data.nameControls, [
		{ control: 'lastName', required: false },
		{ control: 'firstName', required: true }
	]);
	assert.deepEqual(data.prefill, { name: 'Nomi Vance', firstName: 'Nomi', lastName: 'Vance' });
});

test('R6: a request stores every control under its role’s key and joins the name in the skin’s order, through approval', async () => {
	const res = await post({
		firstName: 'Nomi',
		lastName: 'Vance',
		linkedin: 'https://example.org/nomi',
		aff_crew: 'on',
		otherAffiliations: 'Local group',
		publicProfile: 'on'
	});
	assert.equal(res.submitted, true);
	const stored = {
		surname: 'Vance',
		forename: 'Nomi',
		workProfile: 'https://example.org/nomi',
		crew: 'TRUE',
		otherGroups: 'Local group',
		showOnHome: 'TRUE'
	};
	assert.deepEqual(db.requests[0].data, stored);
	// The admins' card, the notice and the member row agree on the name.
	assert.equal(db.requests[0].name, 'Vance Nomi');
	assert.equal(notices[0].find((r) => r.label === 'Name')?.value, 'Vance Nomi');
	const [card] = await listRequests(GROUP as never);
	assert.equal(card.name, 'Vance Nomi');
	assert.deepEqual(card.details[0], { label: 'Associated with', value: 'Crew, Local group' });

	await approveRequest(GROUP as never, db.requests[0].id, {
		actorSubject: 'email:admin@example.org'
	});
	const member = db.members[0];
	assert.deepEqual(
		{ name: member.name, linkedin: member.linkedin, data: member.data },
		{ name: 'Vance Nomi', linkedin: 'https://example.org/nomi', data: stored }
	);

	// Read back into the edit form: each value under the control that posts it.
	const row = { ...member, data: member.data, privateData: member.private_data };
	assert.deepEqual(
		readEditFields(row as never).map((f) => [f.name, f.value]),
		[
			['surname', 'Vance'],
			['forename', 'Nomi'],
			['workProfile', 'https://example.org/nomi'],
			['about', ''],
			['phone', '']
		]
	);
	// The form sets the bio apart by role, and posts it under its key.
	assert.deepEqual(
		readEditFields(row as never)
			.filter((f) => f.bio)
			.map((f) => f.name),
		['about']
	);
	assert.deepEqual(readAffiliations(row as never), {
		checks: { crew: true },
		other: 'Local group',
		publicProfile: true
	});
});

test('R6: the given name is the required part wherever the skin lists it, and a refusal echoes each control', async () => {
	const res = await post({
		lastName: 'Vance',
		linkedin: 'https://example.org/nomi',
		otherAffiliations: 'Local group',
		publicProfile: 'on'
	});
	assert.equal(res.status, 400);
	assert.equal(res.data.error, 'First name is required.');
	assert.deepEqual(res.data.values, {
		lastName: 'Vance',
		firstName: '',
		linkedin: 'https://example.org/nomi',
		otherAffiliations: 'Local group'
	});
	assert.equal(res.data.publicProfile, true);
	assert.equal(db.requests.length, 0);

	// A family name alone is not required.
	const ok = await post({
		firstName: 'Nomi',
		linkedin: 'https://example.org/nomi',
		aff_crew: 'on'
	});
	assert.equal(ok.submitted, true);
	assert.equal(db.requests[0].name, 'Nomi');
	assert.equal(db.requests[0].data.showOnHome, 'FALSE');
});

test('R6: the profile form’s fixed controls save under their role’s key, and a refused save echoes them', () => {
	const u = formUpdate(
		formOf({
			forename: 'Nomi',
			surname: 'Vance',
			about: 'Hello.',
			publicProfile: 'on',
			otherAffiliations: 'Local group',
			aff_crew: 'on'
		})
	);
	const patch = profilePatch(u);
	assert.doesNotThrow(() => validatePatch(patch, { writer: 'form', mayWritePrivate: false }));
	assert.deepEqual(
		{ ...patch },
		{
			forename: 'Nomi',
			surname: 'Vance',
			about: 'Hello.',
			crew: true,
			otherGroups: 'Local group',
			showOnHome: true
		}
	);
	assert.deepEqual(choiceEcho(u), {
		checks: { crew: true },
		other: 'Local group',
		publicProfile: true
	});
	assert.deepEqual(formEcho(u), { surname: 'Vance', forename: 'Nomi', about: 'Hello.' });

	// Unticked and blank are a decision too, stored at the same keys.
	const cleared = profilePatch(formUpdate(formOf({ forename: 'Nomi' })));
	assert.deepEqual(
		{ ...cleared },
		{ forename: 'Nomi', crew: false, otherGroups: '', showOnHome: false }
	);

	// A name no field or control answers to is still refused, never dropped,
	// and a forged box cannot reach the echo.
	const forged = formUpdate(formOf({ forename: 'Nomi', nickname: 'N', aff___proto__: 'on' }));
	assert.throws(
		() => validatePatch(profilePatch(forged), { writer: 'form', mayWritePrivate: false }),
		(e: unknown) => e instanceof MemberWriteError && e.status === 400
	);
	assert.deepEqual(choiceEcho(forged).checks, { crew: false });
});

test('R6: both forms post the fixed controls under the names the server binds by role', () => {
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
	const request = read('./+page.svelte');
	const edit = read('../members/[id]/edit/+page.svelte');
	for (const role of ['affiliationOther', 'publicProfile'] as const) {
		for (const page of [request, edit]) {
			assert.ok(
				page.includes(`name="${ROLE_CONTROLS[role]}"`),
				`no ${ROLE_CONTROLS[role]} control`
			);
		}
	}
	assert.match(request, /name=\{c\.control\}/);
	for (const role of ['name', 'givenName', 'familyName'] as const) {
		assert.match(request, new RegExp(`\\b${ROLE_CONTROLS[role]}: '`), `no label for ${role}`);
	}
	for (const page of [request, edit]) assert.ok(page.includes('name={`aff_${a.key}`}'));
	// The bio textarea is the bio-role field's, under that field's key.
	assert.match(edit, /name=\{bioField\.name\}/);
	assert.doesNotMatch(edit, /name="bio"/);
	// The echo of a refused save reaches the controls it is for.
	assert.match(edit, /checked=\{choices\.publicProfile\}/);
	assert.match(edit, /value=\{choices\.other\}/);
	assert.match(edit, /checked=\{choices\.checks\[a\.key\]\}/);
});
