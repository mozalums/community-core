import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mock, test } from 'node:test';

// The username rule, and the reference docs that describe it. The rule is
// pure; the module's queries are never reached here.
mock.module('$lib/server/postgres', { namedExports: { query: async () => ({ rows: [] }) } });

const { checkUsername, RESERVED_USERNAMES, USERNAME_MAX, USERNAME_MIN } =
	await import('./usernames');

const rule = (raw: string) => {
	const v = checkUsername(raw);
	return v.ok ? 'ok' : v.status === 'invalid' ? v.rule : v.status;
};

test('F11 R2: a username is 3 to 30 of a-z, digits and inner single hyphens, lowercased', () => {
	assert.deepEqual(checkUsername('Ada-Lovelace'), { ok: true, name: 'ada-lovelace' });
	assert.deepEqual(checkUsername('  ada99 '), { ok: true, name: 'ada99' });
	assert.equal(rule('ab'), 'length');
	assert.equal(rule('a'.repeat(USERNAME_MIN)), 'ok');
	assert.equal(rule('a'.repeat(USERNAME_MAX)), 'ok');
	assert.equal(rule('a'.repeat(USERNAME_MAX + 1)), 'length');
	for (const bad of ['-ada', 'ada-', 'ada--b', 'ada_b', 'ada.b', 'ada b', 'ada/b', 'ada%2f']) {
		assert.equal(rule(bad), 'pattern', bad);
	}
});

test('F11 R2: look-alike Unicode is refused, never folded to its ASCII twin', () => {
	// Cyrillic а, Greek ο, fullwidth Ａ, a dotted İ that lowercases to two code
	// points, and a combining accent: each reads as a Latin name and is refused.
	for (const bad of ['аda', 'bοb', 'Ａda', 'İsa', 'adé', 'adá']) {
		assert.equal(rule(bad), 'ascii', JSON.stringify(bad));
	}
});

test('F11 R2: all digits, a uuid and a reserved name are refused, each by its own rule', () => {
	assert.equal(rule('12345'), 'digits');
	assert.equal(rule('1999-2003'), 'ok');
	assert.equal(rule('0f8c3e4a-1b2c-4d5e-8f90-123456789abc'), 'uuid');
	assert.equal(rule('0F8C3E4A1B2C4D5E8F90123456789ABC'), 'uuid');
	for (const name of ['me', 'new', 'admin', 'api', 'login', 'logout']) {
		assert.ok(RESERVED_USERNAMES.has(name), name);
		if (name.length >= USERNAME_MIN) assert.equal(rule(name.toUpperCase()), 'reserved', name);
	}
	const refused = checkUsername('ab');
	assert.ok(!refused.ok && refused.status === 'invalid' && /3 to 30/.test(refused.message));
});

test('F11 R2: every child segment of the members route directory is reserved', () => {
	const dir = new URL('../../routes/group/[slug]/members/', import.meta.url);
	const segments = readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && !/^[[(]/.test(e.name))
		.map((e) => e.name);
	assert.ok(segments.includes('usernames'), 'the availability endpoint moved; update this test');
	for (const s of segments) {
		assert.ok(RESERVED_USERNAMES.has(s), `members/${s}/ is a route but "${s}" is not reserved`);
	}
});

test('F11 R2: the endpoint and the save action call the same rule', () => {
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
	assert.match(read('./usernames.ts'), /usernameStatus[\s\S]*checkUsername\(raw\)/);
	assert.match(read('./member-edit.ts'), /checkUsername\(username\)/);
	assert.match(read('../../routes/group/[slug]/members/usernames/+server.ts'), /usernameStatus\(/);
});

test('F11 R6: the reference docs describe usernames, both URL forms and the retired table', () => {
	const features = readFileSync(new URL('../../../docs/features.md', import.meta.url), 'utf8');
	const section = features.split(/^### Usernames$/m)[1]?.split(/^#{2,3} /m)[0] ?? '';
	assert.ok(section, 'docs/features.md has no Usernames section');
	for (const topic of [/3 to 30/, /look-alike/, /reserved/i, /308/, /retired/i, /Release/]) {
		assert.match(section, topic);
	}
	const editAt = features.indexOf('**Profile editing**');
	const userAt = features.indexOf('### Usernames');
	assert.ok(editAt >= 0 && userAt > editAt, 'Usernames does not sit beside Profile editing');
	assert.match(features, /\| `\/members\/<id-or-username>`/);
	const model = readFileSync(new URL('../../../docs/data-model.md', import.meta.url), 'utf8');
	assert.match(model, /`username`/);
	assert.match(model, /member_username_retired/);
});

test("F11 R3: the member's edit page mounts the username check against the endpoint", () => {
	const page = readFileSync(
		new URL('../../routes/group/[slug]/members/[id]/edit/+page.svelte', import.meta.url),
		'utf8'
	);
	assert.match(
		page,
		/\{#if data\.username\}[\s\S]*<UsernameField[\s\S]*endpoint=\{`\$\{base\}\/members\/usernames`\}[\s\S]*name=\{data\.username\.control\}/
	);
	const field = readFileSync(
		new URL('../components/UsernameField.svelte', import.meta.url),
		'utf8'
	);
	assert.match(field, /delay = 400/);
	assert.match(field, /aria-live="polite"/);
});
