import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	MAX_PROFILE_URL_LENGTH,
	badProfileUrls,
	checkProfileUrl,
	profileHref
} from './profile-url';
import { MemberWriteError, validatePatch } from './member-write-core';
import type { FieldDef } from './field-schema';

const refused = (raw: string) => {
	const c = checkProfileUrl(raw);
	assert.equal(c.ok, false, `${raw} was accepted`);
	return (c as { reason: string }).reason;
};
const accepted = (raw: string) => {
	const c = checkProfileUrl(raw);
	assert.ok(c.ok, `${raw} was refused: ${(c as { reason?: string }).reason}`);
	return c.url;
};

test('B30 1: javascript:, data: and http: are refused for their scheme', () => {
	for (const raw of [
		'javascript:alert(1)',
		'JavaScript:alert(1)',
		' javascript:alert(1)',
		'data:text/html,<script>alert(1)</script>',
		'http://linkedin.com/in/x',
		'ftp://example.org/x'
	]) {
		assert.equal(refused(raw), 'must start with https://', raw);
	}
});

test('B30 1: a username or password in the URL is refused', () => {
	assert.match(refused('https://user:pw@linkedin.com/in/x'), /username or password/);
	assert.match(refused('https://user@linkedin.com/in/x'), /username or password/);
});

test('B30 1: a URL with no host is refused', () => {
	assert.equal(refused('https://'), 'is not a valid web address');
	assert.equal(refused('https:'), 'is not a valid web address');
	assert.equal(refused('https://exa mple.org'), 'is not a valid web address');
});

test('B30 1: the length cap counts the stored form, https:// included', () => {
	const at = `https://example.org/${'a'.repeat(MAX_PROFILE_URL_LENGTH - 'https://example.org/'.length)}`;
	assert.equal(at.length, MAX_PROFILE_URL_LENGTH);
	accepted(at);
	assert.match(refused(`${at}a`), /longer than 2048/);
	const bare = at.slice('https://'.length);
	accepted(bare);
	assert.match(refused(`${bare}a`), /longer than 2048/);
});

test('B30 1: an IDN host is accepted and stored as typed, not as punycode', () => {
	assert.equal(accepted('https://bücher.example/ada'), 'https://bücher.example/ada');
});

test('B30 1: a bare linkedin.com/in/x is stored with https:// prepended', () => {
	assert.equal(accepted('linkedin.com/in/x'), 'https://linkedin.com/in/x');
	assert.equal(accepted('  linkedin.com/in/x '), 'https://linkedin.com/in/x');
	assert.equal(accepted('https://www.linkedin.com/in/x'), 'https://www.linkedin.com/in/x');
});

test('B30 3: profileHref links only what the save check accepts', () => {
	assert.equal(profileHref('javascript:alert(1)'), null);
	assert.equal(profileHref('http://linkedin.com/in/x'), null);
	assert.equal(profileHref(''), null);
	assert.equal(profileHref(null), null);
	assert.equal(profileHref('linkedin.com/in/x'), 'https://linkedin.com/in/x');
});

const SCHEMA: FieldDef[] = [
	{ key: 'name', label: 'Name', type: 'text', visibility: 'members', role: 'name', order: 0 },
	{ key: 'site', label: 'LinkedIn URL', type: 'url', visibility: 'members', order: 1 },
	{ key: 'photo', label: 'Photo', type: 'url', visibility: 'private', role: 'avatar', order: 2 }
] as FieldDef[];
const opts = { writer: 'system' as const, mayWritePrivate: true, schema: SCHEMA };

test('B30 1: validatePatch refuses a bad url field with 400, its label, the reason and the key', () => {
	assert.throws(
		() => validatePatch({ name: 'Ada', site: 'javascript:alert(1)' }, opts),
		(e: unknown) =>
			e instanceof MemberWriteError &&
			e.status === 400 &&
			e.message === 'LinkedIn URL must start with https://' &&
			e.field === 'site'
	);
});

test('B30 1: validatePatch prepends the scheme, and an empty value still clears', () => {
	assert.equal(
		validatePatch({ site: 'linkedin.com/in/x' }, opts).site,
		'https://linkedin.com/in/x'
	);
	assert.equal(validatePatch({ site: '' }, opts).site, '');
	assert.equal(validatePatch({ site: '   ' }, opts).site, '   ');
});

test('B30 1: the avatar field passes the same check, and empty still clears it', () => {
	assert.throws(
		() => validatePatch({ photo: 'http://localhost:5173/avatar/x' }, opts),
		(e) => e instanceof MemberWriteError && e.status === 400 && e.field === 'photo'
	);
	assert.equal(
		validatePatch({ photo: 'https://dir.example/avatar/x' }, opts).photo,
		'https://dir.example/avatar/x'
	);
	assert.equal(validatePatch({ photo: '' }, opts).photo, '');
});

test('B30 1: a scheme spelling that resolves against the page is refused', () => {
	for (const raw of [
		'https:example.org/ada',
		'https:/example.org/ada',
		'HTTPS:example.org',
		'https:/page.invalid/../ada',
		'https:page.invalid/../../../ada',
		'https:\\\\example.org/ada',
		'https:/\\example.org/ada',
		'https:///example.org/ada'
	]) {
		assert.deepEqual(checkProfileUrl(raw), { ok: false, reason: 'must start with https://' }, raw);
	}
});

test('B30 1: every accepted value lands on the same URL from any page and from none', () => {
	const pages = [
		'https://directory.example/group/a/members/1',
		'https://page.invalid/a/b/c',
		'https://example.org/',
		'https://another.example/members/2?q=1#x',
		'http://localhost:5173/group/a/members/1/edit'
	];
	const hosts = ['example.org', 'page.invalid', 'directory.example', 'bücher.example'];
	const prefixes = ['', 'https://', 'HTTPS://', 'https:', 'https:/', 'https:\\\\', 'https:///', '//', '/'];
	const paths = ['', '/', '/ada', '/../ada', '/./a/../../ada', '/%2e%2e/ada', '?q=1', '#x', '/a/..'];
	let checked = 0;
	for (const prefix of prefixes) {
		for (const host of hosts) {
			for (const path of paths) {
				const raw = `${prefix}${host}${path}`;
				const c = checkProfileUrl(raw);
				if (!c.ok) continue;
				checked++;
				const alone = new URL(c.url).href;
				assert.equal(new URL(alone).protocol, 'https:', raw);
				for (const page of pages) assert.equal(new URL(c.url, page).href, alone, `${raw} on ${page}`);
				assert.equal(profileHref(raw), c.url, raw);
				assert.equal(validatePatch({ site: raw }, opts).site, c.url, raw);
			}
		}
	}
	assert.ok(checked >= hosts.length * paths.length * 3, `only ${checked} spellings accepted`);
});

test('B30 5: badProfileUrls lists every refused stored value and nothing else', () => {
	const bad = badProfileUrls(
		[
			{ id: 'a', values: { site: 'javascript:alert(1)' } },
			{ id: 'b', values: { site: 'https://linkedin.com/in/b' } },
			{ id: 'c', values: { site: 'linkedin.com/in/c' } },
			{ id: 'd', values: { site: 'http://linkedin.com/in/d', other: 'javascript:x' } },
			{ id: 'e', values: { site: '' } },
			{ id: 'f', values: {} }
		],
		['site']
	);
	assert.deepEqual(
		bad.map((b) => [b.memberId, b.key, b.reason]),
		[
			['a', 'site', 'must start with https://'],
			['d', 'site', 'must start with https://']
		]
	);
});
