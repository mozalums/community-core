// Renders the directory tile through the Svelte compiler's server output, so
// the assertions read the HTML a visitor receives rather than the source. The
// suite runs under plain `node --test`, which knows neither `.svelte` files nor
// the `$lib` alias, so this file teaches it both before importing the tile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';

const lib = fileURLToPath(new URL('..', import.meta.url));

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (!specifier.startsWith('$lib/')) return nextResolve(specifier, context);
		const path = lib + specifier.slice('$lib/'.length);
		const file = existsSync(path) ? path : `${path}.ts`;
		return { url: pathToFileURL(file).href, shortCircuit: true };
	},
	load(url, context, nextLoad) {
		if (!url.endsWith('.svelte')) return nextLoad(url, context);
		const filename = fileURLToPath(url);
		const { js } = compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' });
		return { format: 'module', source: js.code, shortCircuit: true };
	}
});

const { render } = await import('svelte/server');
const { default: MemberTile } = await import('./MemberTile.svelte');

// 70 characters: past what one line holds in a 1/3-width column at 1280px.
const LONG = 'Maximiliana Konstantinopoulou-Vanderbilt de la Torre y Fitzgerald-Nguy';
assert.equal(LONG.length, 70);

function tile(name: string | null, city: string | null = 'Saint-Jean-sur-Richelieu') {
	const { body } = render(MemberTile, {
		props: {
			member: {
				id: 'm1',
				name,
				city,
				avatarId: null,
				matched: []
			},
			href: '/group/g/members/m1',
			base: '/group/g',
			starred: false
		}
	});
	return body;
}

// The name element, found by its title: its text is split across a one-line
// given-names span and the surname, so no element contains the name verbatim.
function nameTag(html: string, name: string): string {
	const tag = html.match(new RegExp(`<p\\s[^>]*title="${escapeAttr(name)}"[^>]*>`))?.[0];
	assert.ok(tag, `no name element titled ${JSON.stringify(name)}`);
	return tag;
}

const escapeAttr = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The opening tag of the element whose text content is exactly `text`.
function tagAround(html: string, text: string): string {
	const close = html.indexOf(`>${text}<`);
	assert.notEqual(close, -1, `no element contains exactly ${JSON.stringify(text)}`);
	return html.slice(html.lastIndexOf('<', close), close + 1);
}

const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const classes = (tag: string) => (attr(tag, 'class') ?? '').split(/\s+/);
const unescape = (s: string) =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');

// Svelte's SSR output wraps text in hydration comments; strip them so the
// element's text reads as it does in the DOM.
const plain = (html: string) => html.replace(/<!--[^]*?-->/g, '');

test('a long name wraps to two lines instead of truncating to one', () => {
	const name = nameTag(plain(tile(LONG)), LONG);
	const cls = classes(name);
	assert.ok(!cls.includes('truncate'), `name still truncates: ${name}`);
	for (const c of ['line-clamp-2', 'break-words', 'hyphens-auto']) {
		assert.ok(cls.includes(c), `name lacks ${c}: ${name}`);
	}
});

// The markup a one-line name depends on: everything before the last word sits
// in a one-line box, and the last word follows it outside that box.
test('the surname is never inside the one-line given-names box', () => {
	const html = plain(tile('Alexandria-Christine Montgomery'));
	const given = html.match(/<span data-given-names[^>]*>([^<]*)<\/span>([^<]*)<\/p>/);
	assert.ok(given, `no given-names span: ${html}`);
	for (const c of ['inline-block', 'max-w-full', 'truncate']) {
		assert.ok(classes(given[0]).includes(c), `given names lack ${c}: ${given[0]}`);
	}
	assert.equal(given[1], 'Alexandria-Christine');
	assert.equal(given[2].trim(), 'Montgomery');
	assert.ok(!plain(tile('Cher')).includes('data-given-names'), 'a one-word name grew a given-names box');
});

test('the city keeps a single truncated line', () => {
	const city = tagAround(plain(tile(LONG)), 'Saint-Jean-sur-Richelieu');
	assert.ok(classes(city).includes('truncate'), city);
	assert.ok(!classes(city).includes('line-clamp-2'), city);
});

test('a clamped name stays available to pointer and screen reader users', () => {
	const html = plain(tile(LONG));
	assert.equal(unescape(attr(nameTag(html, LONG), 'title') ?? ''), LONG);
	const anchor = html.match(/<a\s[^>]*>/)?.[0] ?? '';
	const label = unescape(attr(anchor, 'aria-label') ?? '');
	assert.ok(label.includes(LONG), `anchor accessible name lacks the full name: ${anchor}`);
	assert.ok(label.includes('Saint-Jean-sur-Richelieu'), `anchor name lacks the city: ${anchor}`);
});

test('an unnamed member is labeled with the placeholder the tile shows', () => {
	const html = plain(tile(null, null));
	const anchor = html.match(/<a\s[^>]*>/)?.[0] ?? '';
	assert.equal(attr(anchor, 'aria-label'), 'Unnamed member');
});

// The star is absolutely positioned at the tile's bottom-right, so nothing in
// the flow avoids it except the fixed-width gutter beside the text column. The
// gutter is a flex child of the anchor, so it spans every line the name wraps
// to; this holds both halves of that arrangement in place.
test('a wrapped name stays clear of the corner star', () => {
	const html = plain(tile(LONG));
	const gutter = html.match(/<span data-star-gutter[^>]*>/)?.[0] ?? '';
	assert.deepEqual(classes(gutter).sort(), ['shrink-0', 'w-5']);
	assert.ok(html.indexOf(LONG) < html.indexOf(gutter), 'gutter is not after the text column');
	assert.ok(html.indexOf(gutter) < html.indexOf('</a>'), 'gutter left the anchor');
	const star = html.match(/<button[^>]*>/)?.[0] ?? '';
	for (const c of ['absolute', 'bottom-2.5', 'right-2.5']) {
		assert.ok(classes(star).includes(c), `star lost ${c}: ${star}`);
	}
});

test('R1 (E51): the tile star is the shared StarButton, seeded from the starred prop', () => {
	for (const starred of [true, false]) {
		const { body } = render(MemberTile, {
			props: {
				member: { id: 'm1', name: 'Ada', city: null, avatarId: null, matched: [] },
				href: '/group/g/members/m1',
				base: '/group/g',
				starred
			}
		});
		const star = body.match(/<button[^>]*>/)?.[0] ?? '';
		assert.equal(attr(star, 'aria-pressed'), String(starred));
		assert.equal(attr(star, 'aria-label'), starred ? 'Unstar' : 'Star');
	}
});
