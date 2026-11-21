import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import * as copy from '$lib/server/skin-copy';

// Both landing views fill the band's count from `countMembers`, the query the
// signed-in sidebar shows, so the landing and the directory cannot disagree.
// The default skin's band carries no count, so the band here is stubbed with one.

const GROUP = {
	id: 'a7c1e4f2-5b3d-4a80-9c6e-2f8b1d3e0a44',
	slug: 'example',
	name: 'Example',
	landingMd: ''
};
const BAND = `<h2>Find your people.</h2>\n<p>${copy.MEMBER_COUNT} members and counting.</p>\n`;
const counted: string[] = [];

mock.module('$lib/server/groups', { namedExports: { getGroupBySlug: async () => GROUP } });
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (sql: string) => {
			if (!/count\(\*\)/.test(sql)) return { rows: [], rowCount: 0 };
			counted.push(sql);
			return { rows: [{ n: 1262 }], rowCount: 1 };
		},
		withTransaction: async () => assert.fail('the landing load writes nothing')
	}
});
mock.module('$lib/server/skin-copy', {
	namedExports: {
		...copy,
		skinCopy: (name: copy.CopyName) => (name === 'landing-band' ? BAND : copy.skinCopy(name))
	}
});

const { load: landing } = await import('./+page.server');
const { load: home } = await import('./home/+page.server');
const { countMembers } = await import('$lib/server/members');

/* eslint-disable @typescript-eslint/no-explicit-any */
const guest = () =>
	landing({
		parent: async () => ({ member: null, isGroupAdmin: false }),
		params: { slug: GROUP.slug },
		url: new URL('https://www.example.org/')
	} as any) as Promise<{ bandHtml: string }>;
const signedIn = () =>
	home({
		parent: async () => ({ member: null, isGroupAdmin: false }),
		locals: { user: { email: 'a@example.org' } },
		params: { slug: GROUP.slug },
		url: new URL('https://www.example.org/home')
	} as any) as Promise<{ bandHtml: string }>;
/* eslint-enable @typescript-eslint/no-explicit-any */

test('E35 R4: both landing views show the count the directory sidebar reads', async () => {
	counted.length = 0;
	const sidebar = await countMembers(GROUP.id);
	const { bandHtml } = await guest();
	assert.equal((await signedIn()).bandHtml, bandHtml);
	assert.equal(counted.length, 3);
	assert.ok(
		counted.every((q) => q === counted[0]),
		'the landing counts with a different query'
	);
	assert.equal(bandHtml, `<h2>Find your people.</h2>\n<p>1,262 members and counting.</p>\n`);
	assert.equal(sidebar, 1262);
});

test('E35 R4: copy without the token never reads the count', async () => {
	let reads = 0;
	const html = '<p>No number here.</p>';
	assert.equal(await copy.withMemberCount(html, async () => ++reads), html);
	assert.equal(reads, 0);
});
