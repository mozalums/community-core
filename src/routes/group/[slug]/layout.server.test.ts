import assert from 'node:assert/strict';
import { test, mock } from 'node:test';

// The build id reaches two surfaces from one loader: the guest landing footer and
// the signed-in sidebar. A signed-in visitor is redirected past the landing page,
// so neither alone covers both, and the loader is the only shared point.

const GROUP = { id: 'g1', slug: 'moz', name: 'Example Community' };

mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/members', {
	namedExports: { resolveMember: async () => null, countMembers: async () => 0 }
});
mock.module('$lib/server/avatars', { namedExports: { avatarIdFor: async () => null } });

const { load } = await import('./+layout.server');

function loadGuest() {
	return load({
		params: { slug: 'moz' },
		url: new URL('https://www.example.org/'),
		locals: { user: null }
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
}

test('the build id is short, and absent rather than a placeholder', async (t) => {
	const before = process.env.LOREM_BUILD_SHA;
	t.after(() => {
		if (before === undefined) delete process.env.LOREM_BUILD_SHA;
		else process.env.LOREM_BUILD_SHA = before;
	});

	process.env.LOREM_BUILD_SHA = '116bdb2d4e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4b';
	let out = (await loadGuest()) as { buildSha: string };
	assert.equal(out.buildSha, '116bdb2', 'the full sha reached the page');

	// Every build outside a deploy supplies nothing, so both surfaces must omit
	// the line rather than print a word that reads to a member like a fault.
	process.env.LOREM_BUILD_SHA = 'unknown';
	out = (await loadGuest()) as { buildSha: string };
	assert.equal(out.buildSha, '', "'unknown' reached a rendered surface as text");

	delete process.env.LOREM_BUILD_SHA;
	out = (await loadGuest()) as { buildSha: string };
	assert.equal(out.buildSha, '', 'an unset variable reached a rendered surface as text');
});

test('E44 R5: the core tag reaches the page beside the build, and is absent when unset', async (t) => {
	const before = process.env.CORE_TAG;
	t.after(() => {
		if (before === undefined) delete process.env.CORE_TAG;
		else process.env.CORE_TAG = before;
	});

	process.env.CORE_TAG = 'v1.4.2\n';
	let out = (await loadGuest()) as { coreTag: string };
	assert.equal(out.coreTag, 'v1.4.2');

	delete process.env.CORE_TAG;
	out = (await loadGuest()) as { coreTag: string };
	assert.equal(out.coreTag, '', 'an unset tag reached a rendered surface as text');
});
