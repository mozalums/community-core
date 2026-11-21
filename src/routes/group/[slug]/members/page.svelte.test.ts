// Server-renders the directory page to check how it presents field filters.
// The page and its search box read `$app/stores` and `$app/navigation`, which
// exist only inside SvelteKit, so small stand-ins replace them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';

const lib = fileURLToPath(new URL('../../../../lib/', import.meta.url));
const STUBS: Record<string, string> = {
	'$app/stores': `export const page = { subscribe(run) {
		run({ url: new URL('http://localhost/group/example/members') });
		return () => {};
	} };`,
	'$app/navigation': 'export const goto = async () => {};'
};

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier in STUBS) return { url: `virtual:${specifier}`, shortCircuit: true };
		if (!specifier.startsWith('$lib/')) return nextResolve(specifier, context);
		const path = lib + specifier.slice('$lib/'.length);
		const file = existsSync(path) ? path : `${path}.ts`;
		return { url: pathToFileURL(file).href, shortCircuit: true };
	},
	load(url, context, nextLoad) {
		if (url.startsWith('virtual:')) {
			return { format: 'module', source: STUBS[url.slice('virtual:'.length)], shortCircuit: true };
		}
		if (!url.endsWith('.svelte')) return nextLoad(url, context);
		const filename = fileURLToPath(url);
		const { js } = compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' });
		return { format: 'module', source: js.code, shortCircuit: true };
	}
});

const { render } = await import('svelte/server');
const { default: Page } = await import('./+page.svelte');

type Filter = { label: string; value: string; without: string };

function directory(filters: Filter[], extra: { q?: string; members?: unknown[] } = {}) {
	const members = extra.members ?? [];
	const data = {
		group: { slug: 'example', name: 'Example' },
		members,
		count: members.length,
		filtered: filters.length > 0 || !!extra.q,
		relaxed: false,
		fuzzy: false,
		unsearchable: false,
		starredView: false,
		filters,
		query: { q: extra.q ?? '' }
	};
	return render(Page, { props: { data } as never }).body;
}

const text = (html: string) =>
	html
		.replace(/<!--[^>]*-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ');

const ADA = {
	id: 'm1',
	ref: 'm1',
	name: 'Ada Byron',
	city: 'Toronto',
	avatarId: null,
	starred: false,
	matched: []
};

test('F13 R5: each applied filter is a chip with its label, value and a link removing it alone', () => {
	const html = directory(
		[
			{ label: 'Country', value: 'Canada', without: '?q=ada&startYear=2012' },
			{ label: 'Start Year', value: '2012', without: '?q=ada&country=Canada' }
		],
		{ q: 'ada', members: [ADA] }
	);
	const chips = html.match(/<ul[^>]*aria-label="Filters"[^>]*>[\s\S]*?<\/ul>/)?.[0];
	assert.ok(chips, 'no filter chips');
	assert.match(text(chips), /Country: Canada .*Start Year: 2012/);
	const removers = [...chips.matchAll(/<a href="([^"]*)"[^>]*aria-label="([^"]*)"/g)].map((m) => [
		m[1],
		m[2]
	]);
	assert.deepEqual(removers, [
		['/group/example/members?q=ada&amp;startYear=2012', 'Remove filter Country: Canada'],
		['/group/example/members?q=ada&amp;country=Canada', 'Remove filter Start Year: 2012']
	]);
});

test('F13 R5: a filtered list is not headed as the whole directory', () => {
	const heading = (html: string) => text(html.match(/<h1[^>]*>[\s\S]*?<\/h1>/)?.[0] ?? '').trim();
	assert.equal(heading(directory([])), 'Directory');
	assert.equal(
		heading(directory([{ label: 'Country', value: 'Canada', without: '' }], { members: [ADA] })),
		'Filtered Directory'
	);
	assert.ok(!/aria-label="Filters"/.test(directory([])), 'chips with no filter applied');
});

test('F13 R5: the empty state names the filters and the query', () => {
	const html = directory(
		[
			{ label: 'Country', value: 'Georgia', without: '?q=atlanta' },
			{ label: 'City', value: 'Tbilisi', without: '?q=atlanta&country=Georgia' }
		],
		{ q: 'atlanta' }
	);
	assert.match(text(html), /No members match Country: Georgia, City: Tbilisi and “atlanta”\./);
	assert.match(
		text(directory([{ label: 'Country', value: 'Georgia', without: '' }])),
		/No members match Country: Georgia\./
	);
});

test('F13 review R5: a filtered starred empty state names the filters', () => {
    const data = {
        group: { slug: 'example', name: 'Example' },
        members: [], count: 0, filtered: true, relaxed: false, fuzzy: false,
        unsearchable: false, starredView: true,
        filters: [{ label: 'Country', value: 'Canada', without: '?starred=1' }],
        query: { q: '' }
    };
    const html = render(Page, { props: { data } as never }).body;
    assert.match(text(html), /No (?:starred )?members match Country: Canada/);
    assert.doesNotMatch(text(html), /You haven't starred anyone yet/);
});
