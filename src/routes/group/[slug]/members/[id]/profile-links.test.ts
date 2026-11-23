// The profile's links, from the stored handles through the load to the
// rendered anchors. The load runs on the default skin's fields, whose links
// field is keyed `links`, plus a private links field only an admin sees; the
// page is server-rendered with a one-value store standing in for `$app/stores`.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

const STORES = 'virtual:app-stores';
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '$app/stores') return { url: STORES, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === STORES) {
			const source = `export const page = { subscribe(run) {
				run({ url: new URL('http://localhost/group/example/members/m1') });
				return () => {};
			} };`;
			return { format: 'module', source, shortCircuit: true };
		}
		if (!url.endsWith('.svelte')) return nextLoad(url, context);
		const filename = fileURLToPath(url);
		const { js } = compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' });
		return { format: 'module', source: js.code, shortCircuit: true };
	}
});

const { currentSkin } = await import('$lib/skin/load');
const { fieldSchemaWith } = await import('$lib/server/field-schema-fake');
const PROFILE_FIELDS = [
	...currentSkin().skin.fields,
	{
		key: 'adminLinks',
		label: 'Admin links',
		type: 'links' as const,
		visibility: 'private' as const,
		sites: ['github']
	}
];
mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(PROFILE_FIELDS) });

const ID = '00000000-0000-4000-8000-0000000000aa';
const MEMBER = {
	id: ID,
	groupId: 'g',
	email: 'ada@example.org',
	identSubject: null,
	name: 'Ada Byron',
	city: null,
	status: 'active',
	data: {
		name: 'Ada Byron',
		links: [
			{ site: 'mastodon', handle: 'ada@mastodon.social' },
			{ site: 'myspace', handle: 'ada' },
			{ site: 'linkedin', handle: 'ada-l' },
			{ site: 'github', handle: 'no/longer/valid' },
			{ site: 'codeberg', handle: 'ada' }
		]
	},
	privateData: { adminLinks: [{ site: 'github', handle: 'ada' }] }
};
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => ({ id: 'g', slug: 'example', name: 'Example' }) }
});
mock.module('$lib/server/members', {
	namedExports: { getMemberById: async () => structuredClone(MEMBER), canEditMember: () => false }
});
mock.module('$lib/server/avatars', { namedExports: { avatarIdFor: async () => null } });
mock.module('$lib/server/postgres', {
	namedExports: { query: async () => ({ rows: [] }) }
});

const { load } = await import('./+page.server');
const { render } = await import('svelte/server');
const { default: Page } = await import('./+page.svelte');

const loaded = async (isGroupAdmin = false) =>
	(await load({
		params: { slug: 'example', id: ID },
		locals: { user: null },
		parent: async () => ({ isGroupAdmin })
	} as never)) as { profile: { details: { key: string; links?: unknown[] }[] } };
const page = async (isGroupAdmin = false) => {
	const data = {
		...(await loaded(isGroupAdmin)),
		group: { slug: 'example', name: 'Example' },
		canEdit: false
	};
	return render(Page, { props: { data } as never }).body;
};

test('the load builds each address from its site, in stored order, leaving out what it cannot show', async () => {
	const links = (await loaded()).profile.details.find((d) => d.key === 'links')?.links;
	assert.deepEqual(links, [
		{
			site: 'mastodon',
			handle: 'ada@mastodon.social',
			label: 'Mastodon',
			icon: 'mastodon',
			href: 'https://mastodon.social/@ada'
		},
		{
			site: 'linkedin',
			handle: 'ada-l',
			label: 'LinkedIn',
			icon: 'linkedin',
			href: 'https://linkedin.com/in/ada-l'
		},
		{
			site: 'codeberg',
			handle: 'ada',
			label: 'Codeberg',
			icon: '/icons/codeberg.svg',
			href: 'https://codeberg.org/ada'
		}
	]);
});

test('each link shows its icon and the handle, opens apart, and carries the bio links’ rel', async () => {
	const html = await page();
	const anchors = [...html.matchAll(/<a\b[^>]*href="(https:[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
	assert.deepEqual(
		anchors.map((a) => a[1]),
		['https://mastodon.social/@ada', 'https://linkedin.com/in/ada-l', 'https://codeberg.org/ada']
	);
	for (const [whole, href, body] of anchors) {
		assert.match(whole, /target="_blank"/, href);
		assert.match(whole, /rel="nofollow noopener noreferrer ugc"/, href);
		assert.match(
			body,
			/<svg[^>]*aria-hidden="true"[^>]*><path d="M|<img src="\/icons\/codeberg\.svg"/,
			href
		);
	}
	assert.match(anchors[0][2], /<\/span> ada@mastodon\.social$/);
	assert.match(anchors[0][2], /<span class="sr-only">Mastodon:<\/span>/);
	assert.ok(!html.includes('myspace'), 'a site the skin no longer offers was rendered');
	assert.ok(!html.includes('no/longer/valid'), 'a handle its site refuses was rendered');
});

test('an admin sees a private links field rendered as links', async () => {
	const html = await page(true);
	assert.match(html, /<a\b[^>]*href="https:\/\/github\.com\/ada"[^>]*>[\s\S]*?<svg/);
	assert.doesNotMatch(await page(), /github\.com\/ada/);
});

test('no link markup is inserted as HTML', () => {
	for (const file of [
		'./+page.svelte',
		'../../../../../lib/components/SiteIcon.svelte',
		'../../../../../lib/components/LinksField.svelte'
	]) {
		assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /\{@html/, file);
	}
});
