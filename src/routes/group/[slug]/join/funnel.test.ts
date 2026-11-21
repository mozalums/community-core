import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reroute } from '../../../../hooks';
import { DEFAULT_GROUP_SLUG } from '$lib/group-nav';

// The template half of D8, read as source on the terms src/lib/a11y.test.ts
// gives: no DOM and no Svelte compiler hook under `node --test`. What these
// catch is a link pointed back at the sign-in flow, or the review step cut
// from the page, which is the regression being guarded against.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const landing = read('../../../../lib/components/Landing.svelte');
const landingPage = read('../+page.svelte');
const joinPage = read('./+page.svelte');
const loginPage = read('../../../(auth)/login/+page.svelte');

// Every anchor whose text is the Register call to action, opening tag included.
function registerAnchors(source: string): string[] {
	const out: string[] = [];
	for (let at = source.indexOf('Not yet a member? Register'); at !== -1; ) {
		const open = source.lastIndexOf('<a', at);
		out.push(source.slice(open, at));
		at = source.indexOf('Not yet a member? Register', at + 1);
	}
	return out;
}

test('Register is not the login link', () => {
	const anchors = registerAnchors(landing);
	assert.equal(anchors.length, 2, 'expected the hero and closing Register links');
	for (const a of anchors) {
		assert.match(a, /href=\{registerHref\}/, 'Register points somewhere other than registerHref');
		assert.doesNotMatch(a, /connectHref/, 'Register shares the Login target');
		assert.doesNotMatch(a, /onclick/, 'Register opens the sign-in modal');
	}
	// A guest's Register target is the join page; Login keeps the sign-in flow.
	assert.match(
		landingPage,
		/registerHref = \$derived\(data\.user \? `\$\{base\}\/request` : `\$\{base\}\/join`\)/
	);
	assert.match(landingPage, /signInHref\(/);
});

test('/join is served at the clean root URL for the default group', () => {
	const url = new URL('https://www.example.org/join');
	assert.equal(
		(reroute as (e: { url: URL }) => string | void)({ url }),
		`/group/${DEFAULT_GROUP_SLUG}/join`
	);
});

test('the join page explains all three steps before it asks for an address', () => {
	const input = joinPage.indexOf('id="join-email"');
	assert.notEqual(input, -1, 'no email input');
	const steps = joinPage.slice(0, input);
	for (const step of ['Confirm your email', 'Tell us who you are', 'Wait for an admin']) {
		assert.ok(steps.includes(step), `"${step}" is missing or comes after the input`);
	}
});

test('the review step says who decides, how long, and what you hear', () => {
	const at = joinPage.indexOf('id="join-review"');
	assert.notEqual(at, -1, 'no review step');
	const review = joinPage.slice(at, joinPage.indexOf('</li>', at)).replace(/\s+/g, ' ');
	assert.match(review, /admins reviews each request by hand/, 'who reviews');
	assert.match(review, /no set turnaround/, 'how long');
	assert.match(review, /email you when you are approved/, 'how you hear');
	assert.match(review, /only one you will get/, 'that a denial sends nothing');
});

test('/login has a way home and a way to request access', () => {
	const img = loginPage.indexOf('<img src="/{brand.wordmark}"');
	assert.notEqual(img, -1, 'no wordmark');
	const before = loginPage.slice(0, img);
	const anchor = before.lastIndexOf('<a href={data.home}');
	assert.notEqual(anchor, -1, 'the wordmark is not a link home');
	assert.equal(before.indexOf('</a>', anchor), -1, 'the home link closes before the wordmark');
	assert.match(loginPage, /<a href=\{data\.joinHref\}/, 'no link to the join page');
});
