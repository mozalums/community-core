// Server-renders the profile page to check what its header offers. The page
// reads `$app/stores` for its URL, which exists only inside SvelteKit, so a
// one-value store stands in for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';

const lib = fileURLToPath(new URL('../../../../../lib/', import.meta.url));
const STORES = 'virtual:app-stores';

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '$app/stores') return { url: STORES, shortCircuit: true };
		if (!specifier.startsWith('$lib/')) return nextResolve(specifier, context);
		const path = lib + specifier.slice('$lib/'.length);
		const file = existsSync(path) ? path : `${path}.ts`;
		return { url: pathToFileURL(file).href, shortCircuit: true };
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

const { render } = await import('svelte/server');
const { default: Page } = await import('./+page.svelte');

function header(extra: { starred?: boolean; canEdit?: boolean }) {
	const data = {
		group: { slug: 'example', name: 'Example' },
		profile: {
			id: 'm1',
			ref: 'm1',
			name: 'Ada Byron',
			handle: null,
			email: null,
			bio: null,
			details: [],
			avatarId: null
		},
		canEdit: false,
		privateFields: null,
		...extra
	};
	return render(Page, { props: { data } as never }).body;
}

const starButton = (html: string) => html.match(/<button[^>]*aria-pressed="[^"]*"[^>]*>/)?.[0];

test('E51 R3: the header shows the star beside Edit, seeded from the load', () => {
	const html = header({ starred: true, canEdit: true });
	const star = starButton(html);
	assert.ok(star, 'no star in the profile header');
	assert.match(star, /aria-pressed="true"/);
	const edit = html.indexOf('/members/m1/edit');
	assert.ok(edit > html.indexOf(star), 'Edit link missing or not after the star');
});

test('E51 R3: a viewer who cannot edit still gets the star', () => {
	assert.match(starButton(header({ starred: false })) ?? '', /aria-pressed="false"/);
});

test('E51 R3: no star state from the load (a guest) renders no star', () => {
	const html = header({ canEdit: true });
	assert.equal(starButton(html), undefined);
	assert.ok(html.includes('/members/m1/edit'), 'Edit link lost when there is no star');
});

function bioParagraph(bio: string) {
	const data = {
		group: { slug: 'example', name: 'Example' },
		profile: {
			id: 'm1',
			ref: 'm1',
			name: 'Ada Byron',
			handle: null,
			email: null,
			bio,
			details: [],
			avatarId: null
		},
		canEdit: false,
		privateFields: null
	};
	const html = render(Page, { props: { data } as never }).body.replace(/<!--[^]*?-->/g, '');
	return html.match(/<p class="whitespace-pre-line[^"]*">([^]*?)<\/p>/)?.[1];
}

test('F12 R3: an https URL in the bio is a link that leaves the site safely', () => {
	const inner = bioParagraph('Hi there.\nMy site: https://Example.org/a.\nBye <b>"x"</b>');
	assert.equal(
		inner,
		'Hi there.\nMy site: <a href="https://example.org/a" target="_blank"' +
			' rel="nofollow noopener noreferrer ugc" class="break-all text-link hover:underline">' +
			'https://Example.org/a</a>.\nBye &lt;b>"x"&lt;/b>'
	);
});

test('F12 R1: a bio with no https URL renders as the same escaped text, no link', () => {
	const inner = bioParagraph('Line one\nhttp://example.org <script>alert(1)</script>');
	assert.equal(inner, 'Line one\nhttp://example.org &lt;script>alert(1)&lt;/script>');
});

// The details come from the real profile load on the default skin, whose
// country and city fields filter, so the link is the one a viewer gets. The
// mocks are set once and read whichever member the test last stored.
let current: Record<string, unknown> = {};
let profileLoad: ((e: never) => Promise<unknown>) | undefined;
async function profileDetails(data: Record<string, string>, city: string | null) {
	current = {
		id: '00000000-0000-4000-8000-0000000000f1',
		groupId: 'g',
		email: 'ada@example.org',
		identSubject: null,
		name: 'Ada Byron',
		city,
		linkedin: null,
		status: 'active',
		username: null,
		data: { name: 'Ada Byron', ...data },
		privateData: {}
	};
	if (!profileLoad) {
		const { mock } = await import('node:test');
		mock.module('$lib/server/groups', {
			namedExports: { getGroupBySlug: async () => ({ id: 'g', slug: 'example', name: 'Example' }) }
		});
		mock.module('$lib/server/members', {
			namedExports: { getMemberById: async () => current, canEditMember: () => false }
		});
		mock.module('$lib/server/avatars', { namedExports: { avatarIdFor: async () => null } });
		mock.module('$lib/server/stars', { namedExports: { isStarred: async () => false } });
		profileLoad = (await import('./+page.server')).load as never;
	}
	const out = (await profileLoad({
		params: { slug: 'example', id: current.id },
		url: new URL(`http://localhost/group/example/members/${current.id}`),
		locals: { user: null },
		parent: async () => ({ isGroupAdmin: false })
	} as never)) as { profile: { details: unknown[] } };
	return out.profile.details;
}

function renderDetails(details: unknown[]) {
	const data = {
		group: { slug: 'example', name: 'Example' },
		profile: {
			id: 'm1',
			ref: 'm1',
			name: 'Ada Byron',
			handle: null,
			email: null,
			bio: null,
			details,
			avatarId: null
		},
		canEdit: false,
		privateFields: null
	};
	return render(Page, { props: { data } as never }).body;
}

const linkTo = (html: string, text: string) =>
	html.match(new RegExp(`<a href="([^"]*)"[^>]*>${text}</a>`))?.[1];

test('F13 R4: a filterable value links to its field filter; the City link carries the country', async () => {
	const details = await profileDetails({ country: 'United States', city: 'Portland' }, 'Portland');
	const html = renderDetails([
		...details,
		{ key: 'town', label: 'Other place', type: 'text', value: 'Pacifica' }
	]);
	assert.equal(linkTo(html, 'United States'), '/group/example/members?country=United%20States');
	assert.equal(
		linkTo(html, 'Portland'),
		'/group/example/members?city=Portland&amp;country=United%20States'
	);
	assert.equal(
		linkTo(html, 'Pacifica'),
		'/group/example/members?q=Pacifica',
		'non-filterable value'
	);
});

test('F13 R4: with no country on the profile, the City link carries the city alone', async () => {
	const html = renderDetails(await profileDetails({ city: 'Portland' }, 'Portland'));
	assert.equal(linkTo(html, 'Portland'), '/group/example/members?city=Portland');
});
