// Structural assertions over the two pages a visitor meets before they are a
// member. Every one of these was either a finding in D10 or something D10
// recorded as already sound, and the sound half is the reason this file exists:
// nothing else in the suite notices when an `alt` or a `loading="lazy"` goes
// missing from a component that renders 260 times.
//
// The assertions read the `.svelte` sources as text rather than rendering them.
// The suite is plain `node --test` with no DOM and no Svelte compiler hook, so
// the choice is source matching or a browser dependency for four attributes.
// This catches a deletion, which is the failure being guarded against; a real
// axe run against the running site is what proves the rendered result, and the
// PR carries one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './server/markdown';
import { skinCopy } from './server/skin-copy';
import { currentSkin } from './skin/load';

// Names and copy come from the loaded skin, so re-skinning changes what is
// asserted and never whether it passes.
const { site } = currentSkin().skin;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const landing = read('./components/Landing.svelte');
const gravatar = read('./components/Gravatar.svelte');
const loginPage = read('../routes/(auth)/login/+page.svelte');
const loginModal = read('./components/LoginModal.svelte');

// The opening tag containing `needle`, attributes included.
function tag(source: string, needle: string): string {
	const at = source.indexOf(needle);
	assert.notEqual(at, -1, `\`${needle}\` is not in the source`);
	const open = source.lastIndexOf('<', at);
	return source.slice(open, source.indexOf('>', at) + 1);
}

test('landing page carries the landmarks a screen reader navigates by', () => {
	assert.match(landing, /<main id="landing-main"/, 'no <main> landmark');
	assert.match(landing, /<\/main>/, 'unclosed <main>');
	assert.match(landing, /<footer/, 'no <footer> landmark');
	assert.match(landing, /<nav aria-label="/, 'footer nav has no accessible name');
});

test('landing page offers a skip link ahead of the avatar grid', () => {
	const skip = landing.indexOf('href="#landing-main"');
	assert.notEqual(skip, -1, 'no skip link targeting the main landmark');
	assert.ok(skip < landing.indexOf('<main'), 'skip link is not before <main>');
	assert.ok(skip < landing.indexOf('<Gravatar '), 'skip link is not before the avatar grid');
});

// The page's one <h1> is the skin hero's level-1 heading; the template adds none.
test('landing template declares no h1, and the skin hero renders exactly one', () => {
	assert.equal((landing.match(/<h1[\s>]/g) ?? []).length, 0);
	assert.equal((skinCopy('landing-hero').match(/<h1[\s>]/g) ?? []).length, 1);
	assert.equal((skinCopy('landing-band').match(/<h1[\s>]/g) ?? []).length, 0);
});

test('landing copy from the admin cannot mint a second h1', () => {
	const html = renderMarkdown(`# ${site.name}\n\nA place to see what is happening.`, {
		headingOffset: 1
	});
	assert.doesNotMatch(html, /<h1[\s>]/);
	assert.match(html, new RegExp(`<h2>${escapeRegExp(site.name)}</h2>`));
	// Relative structure survives the shift, and h6 is the floor.
	assert.match(renderMarkdown('## Sub', { headingOffset: 1 }), /<h3>Sub<\/h3>/);
	assert.match(renderMarkdown('###### Deep', { headingOffset: 1 }), /<h6>Deep<\/h6>/);
	// Every other caller renders unshifted.
	assert.match(renderMarkdown('# Manifesto'), /<h1>Manifesto<\/h1>/);
});

test('both email inputs have a real label bound by id', () => {
	for (const [name, source, id] of [
		['/login', loginPage, 'login-email'],
		['sign-in modal', loginModal, 'login-modal-email']
	] as const) {
		assert.match(source, new RegExp(`<label for="${id}"`), `${name}: no label`);
		assert.match(source, new RegExp(`id="${id}"`), `${name}: input has no id`);
		assert.doesNotMatch(source, /class="sr-only"[^>]*>Email/, `${name}: label is hidden`);
	}
});

// D10 recorded these as sound. They are asserted here so a future change has to
// delete a test to drop them, rather than dropping them quietly.
test('the login input keeps its type, autocomplete and required flag', () => {
	const input = tag(loginPage, 'id="login-email"');
	for (const attr of ['type="email"', 'name="email"', 'required']) {
		assert.ok(input.includes(attr), `login input lost ${attr}`);
	}
	// F8 makes it `username webauthn` where passkeys are on, which is how the
	// browser offers them in autofill. Both are input purposes WCAG 1.3.5 lists.
	assert.ok(
		input.includes(`autocomplete={data.passkeys ? 'username webauthn' : 'email'}`),
		'login input lost its autocomplete purpose'
	);
});

test('every avatar image carries alt text and loads lazily', () => {
	const img = tag(gravatar, 'onerror={() => (missed += 1)}');
	assert.match(img, /alt=\{name \?\? ''\}/, 'avatar image lost its alt');
	assert.match(img, /loading="lazy"/, 'avatar image is no longer lazy-loaded');
});

test('the hero logo is the one eager image, and it is described', () => {
	// Found as the first image in the template, so a renamed logo file still
	// lands on it.
	const logo = tag(landing, '<img');
	assert.match(logo, /alt=\{site\.name\}/, 'hero logo lost its alt');
	assert.doesNotMatch(logo, /loading=/, 'the above-the-fold logo should not be lazy');
});
