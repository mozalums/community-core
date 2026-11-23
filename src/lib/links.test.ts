// Core's site definitions, the reduction a value goes through where it
// enters, and the address a stored handle renders as. `social-links` is the
// oracle for the sites it ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SocialLinks } from 'social-links';
import {
	CORE_SITES,
	checkLinks,
	coreSite,
	expectedForm,
	linkHref,
	linksText,
	offeredSites,
	parseLinksText,
	reduceLink,
	renderLinks,
	storedLinks,
	templateProblem,
	type SiteDef
} from './links';
import { GLYPHS } from './site-glyphs';

const site = (id: string) => coreSite(id)!;

// A custom site as a skin's links field resolves it.
const custom = (url: string): SiteDef =>
	offeredSites({ custom: [{ id: 'custom', label: 'Custom', icon: 'c.svg', url }] })[0];

// Per site: what a member may type or paste, the handle it stores, and the
// address that handle renders as.
const ACCEPTED: Record<string, [input: string, handle: string, href: string][]> = {
	linkedin: [
		['ravinald', 'ravinald', 'https://linkedin.com/in/ravinald'],
		['  ravinald\t', 'ravinald', 'https://linkedin.com/in/ravinald'],
		['https://www.linkedin.com/in/ravinald/', 'ravinald', 'https://linkedin.com/in/ravinald'],
		['https://linkedin.com/in/ravinald', 'ravinald', 'https://linkedin.com/in/ravinald'],
		['http://www.linkedin.com/in/ravinald', 'ravinald', 'https://linkedin.com/in/ravinald'],
		['linkedin.com/in/ravinald', 'ravinald', 'https://linkedin.com/in/ravinald'],
		['https://de.linkedin.com/in/ravinald', 'ravinald', 'https://linkedin.com/in/ravinald'],
		[
			'HTTPS://WWW.LinkedIn.com/in/ravinald/#experience',
			'ravinald',
			'https://linkedin.com/in/ravinald'
		],
		[
			'https://www.linkedin.com/in/ravinald/?trk=public_profile',
			'ravinald',
			'https://linkedin.com/in/ravinald'
		],
		['ada.l-b_2', 'ada.l-b_2', 'https://linkedin.com/in/ada.l-b_2'],
		['josé', 'josé', 'https://linkedin.com/in/josé'],
		['linkedin.com/in/jos%C3%A9', 'jos%C3%A9', 'https://linkedin.com/in/jos%C3%A9']
	],
	github: [
		['ravinald', 'ravinald', 'https://github.com/ravinald'],
		['https://github.com/ravinald', 'ravinald', 'https://github.com/ravinald'],
		['https://www.github.com/ravinald/', 'ravinald', 'https://github.com/ravinald'],
		['https://github.com/ravinald?tab=repositories', 'ravinald', 'https://github.com/ravinald']
	],
	gitlab: [
		['ada.lovelace', 'ada.lovelace', 'https://gitlab.com/ada.lovelace'],
		['https://gitlab.com/ada.lovelace/', 'ada.lovelace', 'https://gitlab.com/ada.lovelace'],
		['www.gitlab.com/ada?tab=x', 'ada', 'https://gitlab.com/ada']
	],
	mastodon: [
		['@ravi@mastodon.social', 'ravi@mastodon.social', 'https://mastodon.social/@ravi'],
		['ravi@mastodon.social', 'ravi@mastodon.social', 'https://mastodon.social/@ravi'],
		['@Ada_L@Hachyderm.IO', 'Ada_L@hachyderm.io', 'https://hachyderm.io/@Ada_L']
	],
	bluesky: [
		['ada.bsky.social', 'ada.bsky.social', 'https://bsky.app/profile/ada.bsky.social'],
		['@ada.bsky.social', 'ada.bsky.social', 'https://bsky.app/profile/ada.bsky.social'],
		['Ada.Bsky.Social', 'Ada.Bsky.Social', 'https://bsky.app/profile/Ada.Bsky.Social'],
		[
			'https://bsky.app/profile/ada.bsky.social',
			'ada.bsky.social',
			'https://bsky.app/profile/ada.bsky.social'
		]
	],
	instagram: [
		['ada.l', 'ada.l', 'https://instagram.com/ada.l'],
		['@ada.l', 'ada.l', 'https://instagram.com/ada.l'],
		['https://instagram.com/ada.l', 'ada.l', 'https://instagram.com/ada.l'],
		['https://www.instagram.com/Ada.L/', 'Ada.L', 'https://instagram.com/Ada.L']
	],
	x: [
		['ada_l', 'ada_l', 'https://x.com/ada_l'],
		['@ada_l', 'ada_l', 'https://x.com/ada_l'],
		['https://x.com/ada_l?s=20', 'ada_l', 'https://x.com/ada_l'],
		['https://twitter.com/ada_l', 'ada_l', 'https://x.com/ada_l'],
		['https://www.twitter.com/@ada_l/', 'ada_l', 'https://x.com/ada_l'],
		['https://mobile.twitter.com/ada_l', 'ada_l', 'https://x.com/ada_l']
	],
	youtube: [
		['AdaTalks', 'AdaTalks', 'https://youtube.com/@AdaTalks'],
		['@AdaTalks', 'AdaTalks', 'https://youtube.com/@AdaTalks'],
		['https://www.youtube.com/@AdaTalks', 'AdaTalks', 'https://youtube.com/@AdaTalks'],
		['https://youtube.com/@AdaTalks/?si=x', 'AdaTalks', 'https://youtube.com/@AdaTalks']
	],
	website: [
		['https://example.org/ada', 'https://example.org/ada', 'https://example.org/ada'],
		['example.org', 'https://example.org/', 'https://example.org/'],
		['https://Example.org/blog/', 'https://example.org/blog/', 'https://example.org/blog/'],
		['https://example.org/a%2Fb', 'https://example.org/a%2Fb', 'https://example.org/a%2Fb'],
		['https://example.org/?q=1#top', 'https://example.org/?q=1#top', 'https://example.org/?q=1#top']
	]
};

// What every handle site refuses: another host, a script, a path past the
// handle, and a handle a stored value could not safely hold.
const NAME_REFUSED = (base: string, handle: string) => [
	base.replace(/^https:\/\/[^/]+/, 'https://example.org') + handle,
	'javascript:alert(1)',
	`${base}${handle}/extra`,
	'ravi/nald',
	'ravi"nald',
	'ravi nald',
	'ravi<b>',
	'ravi nald',
	'ravi\u0085nald',
	'ravi\ud800nald',
	'ravi￾',
	'ravi￿',
	'..',
	'.',
	'%2e%2E',
	'a'.repeat(101),
	'',
	'   '
];

const REFUSED: Record<string, string[]> = {
	linkedin: [
		...NAME_REFUSED('https://www.linkedin.com/in/', 'ravinald'),
		'https://www.linkedin.com/company/acme',
		'https://www.linkedin.com/mwlite/in/ravinald'
	],
	github: [
		...NAME_REFUSED('https://github.com/', 'ravinald'),
		'https://gitlab.com/ravinald',
		'https://github.com/ravinald/repo'
	],
	gitlab: [...NAME_REFUSED('https://gitlab.com/', 'ada'), 'https://github.com/ada'],
	bluesky: [
		...NAME_REFUSED('https://bsky.app/profile/', 'ada.bsky.social'),
		'https://bsky.app/ada.bsky.social'
	],
	instagram: [
		...NAME_REFUSED('https://www.instagram.com/', 'ada'),
		'https://m.instagram.com/ada',
		'https://instagr.am/ada'
	],
	x: [...NAME_REFUSED('https://x.com/', 'ada'), 'https://threads.net/@ada'],
	youtube: [
		...NAME_REFUSED('https://www.youtube.com/@', 'AdaTalks'),
		'https://www.youtube.com/AdaTalks',
		'https://www.youtube.com/channel/UC0123456789',
		'https://www.youtube.com/user/ada',
		'@@AdaTalks'
	],
	mastodon: [
		'ravi',
		// The Kelvin sign lowercases to an ASCII k.
		'@ada@K.example',
		'@ravi@localhost',
		'@ravi@mastodon.social/x',
		'@ravi@mastodon.social:443',
		'@ravi@127.0.0.1',
		'@ravi@0x7f.1',
		'@ravi@café.example',
		'@ra"vi@mastodon.social',
		'@ra/vi@mastodon.social',
		'@..@mastodon.social',
		'@a@b@mastodon.social',
		'https://mastodon.social/@ravi',
		'javascript:alert(1)'
	],
	website: [
		'http://example.org/ada',
		'javascript:alert(1)',
		'https://localhost/ada',
		'https://user:pw@example.org/',
		'ftp://example.org/',
		'https:example.org',
		'https:/example.org/ada',
		'example.org/a\tb',
		'example.org/a\ud800b',
		'https://example.org/' + 'a'.repeat(2048)
	]
};

test('core defines the nine sites, each with a label, a glyph and a Wikidata property', () => {
	assert.deepEqual(
		CORE_SITES.map((s) => s.id),
		['linkedin', 'github', 'gitlab', 'mastodon', 'bluesky', 'instagram', 'x', 'youtube', 'website']
	);
	for (const s of CORE_SITES) {
		assert.ok(s.label && s.icon, s.id);
		assert.match(s.wikidata ?? '', /^P\d+$/, s.id);
		assert.ok(Object.hasOwn(GLYPHS, s.icon), `${s.id}: no glyph ${s.icon}`);
	}
});

// Glyph name > its file under the Font Awesome package's svgs/ directory.
const GLYPH_FILES: Readonly<Record<string, string>> = {
	linkedin: 'brands/linkedin.svg',
	github: 'brands/github.svg',
	gitlab: 'brands/gitlab.svg',
	mastodon: 'brands/mastodon.svg',
	bluesky: 'brands/bluesky.svg',
	instagram: 'brands/instagram.svg',
	'x-twitter': 'brands/x-twitter.svg',
	youtube: 'brands/youtube.svg',
	globe: 'solid/globe.svg'
};

test('each glyph is the path data of the pinned Font Awesome Free file it names', () => {
	const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
		devDependencies: Record<string, string>;
	};
	assert.match(pkg.devDependencies['@fortawesome/fontawesome-free'], /^\d+\.\d+\.\d+$/);
	for (const [name, file] of Object.entries(GLYPH_FILES)) {
		const svg = readFileSync(
			new URL(`../../node_modules/@fortawesome/fontawesome-free/svgs/${file}`, import.meta.url),
			'utf8'
		);
		assert.deepEqual(
			GLYPHS[name],
			{
				viewBox: /viewBox="([^"]+)"/.exec(svg)![1],
				d: /<path[^>]*\sd="([^"]+)"/.exec(svg)![1]
			},
			name
		);
	}
	assert.deepEqual(Object.keys(GLYPHS).sort(), [...new Set(CORE_SITES.map((s) => s.icon))].sort());
});

for (const s of CORE_SITES) {
	test(`${s.id} reduces each recognized form to its handle, which reduces to itself and links over https`, () => {
		for (const [input, handle, href] of ACCEPTED[s.id]) {
			assert.deepEqual(reduceLink(s, input), { ok: true, handle }, input);
			assert.deepEqual(reduceLink(s, handle), { ok: true, handle }, `not idempotent: ${handle}`);
			assert.equal(linkHref(s, handle), href, input);
			assert.equal(new URL(href).protocol, 'https:', href);
		}
	});

	test(`${s.id} refuses another host, javascript:, extra path, a space and a quote`, () => {
		for (const input of REFUSED[s.id]) {
			const c = reduceLink(s, input);
			assert.equal(c.ok, false, `accepted ${JSON.stringify(input)}`);
			assert.equal((c as { message: string }).message, `${s.label}: ${expectedForm(s)}`, input);
		}
	});
}

test('the handle and address are what social-links itself extracts and builds for the sites it ships', () => {
	const oracle = new SocialLinks({ allowQueryParams: true });
	const shipped: Record<string, string> = {
		linkedin: 'linkedin',
		github: 'github',
		instagram: 'instagram',
		x: 'x'
	};
	for (const [id, profile] of Object.entries(shipped)) {
		for (const [input, handle, href] of ACCEPTED[id]) {
			// Scheme and host lowercased, fragment dropped, as reduceLink does.
			const read = input
				.replace(/^(https?:\/\/[^/?#]*)/i, (m) => m.toLowerCase())
				.replace(/#.*$/s, '');
			const name = oracle.isValid(profile, read) ? profile : 'twitter';
			assert.equal(oracle.getProfileId(name, read), handle, input);
			assert.equal(oracle.sanitize(name, read), href, input);
		}
	}
});

test('a matching-host http: address reduces to its handle on every handle site, and website refuses http:', () => {
	for (const s of CORE_SITES.filter((s) => !s.kind)) {
		const handle = ACCEPTED[s.id][0][1];
		const http = linkHref(s, handle)!.replace(/^https:/, 'http:');
		assert.deepEqual(reduceLink(s, http), { ok: true, handle }, http);
	}
	assert.equal(reduceLink(site('website'), 'http://example.org/ada').ok, false);
});

test('a handle may hold any character but whitespace, a control, a lone surrogate or U+FFFE/U+FFFF', () => {
	const s = site('github');
	for (const handle of [
		'josé',
		'Ünal',
		'名前',
		'ada\u{1F600}',
		'a%41',
		'.a',
		'a..b',
		'a'.repeat(100)
	]) {
		assert.deepEqual(reduceLink(s, handle), { ok: true, handle }, JSON.stringify(handle));
	}
	for (const handle of [
		'a\u0000b',
		'a\u007fb',
		'a\u0085b',
		'a b',
		'a b',
		'a　b',
		'a﻿b',
		'a\ud800',
		'\udc00a',
		'a￾',
		'a￿',
		'a'.repeat(101)
	]) {
		assert.equal(reduceLink(s, handle).ok, false, JSON.stringify(handle));
		assert.equal(linkHref(s, handle), null, JSON.stringify(handle));
	}
});

test('a refusal names the site and the form it expects', () => {
	assert.deepEqual(reduceLink(site('linkedin'), 'https://example.org/x'), {
		ok: false,
		message: 'LinkedIn: the part after linkedin.com/in/'
	});
	assert.equal(expectedForm(site('github')), 'the part after github.com/');
	assert.equal(expectedForm(site('youtube')), 'the part after youtube.com/@');
	assert.equal(expectedForm(site('mastodon')), '@user@instance');
	assert.equal(expectedForm(site('website')), 'an https:// address');
	assert.equal(
		expectedForm(custom('https://www.profiles.example/u/~{handle}/about')),
		'the part after profiles.example/u/~'
	);
});

test('a handle that stops passing renders no address and is never rewritten', () => {
	assert.equal(linkHref(site('github'), 'evil.com/x'), null);
	assert.equal(linkHref(site('github'), ' ada'), null);
	assert.equal(linkHref(site('website'), 'localhost'), null);
	assert.equal(linkHref(site('website'), 'example.org/ada'), null);
	assert.equal(linkHref(site('mastodon'), '@ada@mastodon.social'), null);
	assert.equal(linkHref(site('mastodon'), 'ada@Mastodon.social'), null);
	assert.equal(linkHref(site('linkedin'), '..'), null);
	assert.equal(linkHref(site('youtube'), '@AdaTalks'), null);
	assert.equal(linkHref(site('youtube'), 'AdaTalks'), 'https://youtube.com/@AdaTalks');
});

test('entries are checked against the offered sites, one per site, a retired one kept only as stored', () => {
	const sites = [site('linkedin'), site('github')];
	assert.deepEqual(
		checkLinks(
			[
				{ site: 'github', handle: 'https://github.com/ada' },
				{ site: 'linkedin', handle: 'ada' }
			],
			sites
		),
		{
			ok: true,
			entries: [
				{ site: 'github', handle: 'ada' },
				{ site: 'linkedin', handle: 'ada' }
			]
		}
	);
	assert.deepEqual(
		checkLinks(
			[
				{ site: 'github', handle: 'ada' },
				{ site: 'github', handle: 'bob' }
			],
			sites
		),
		{ ok: false, message: 'GitHub: only one link per site' }
	);
	const retired = { site: 'myspace', handle: 'ada' };
	assert.equal(checkLinks([retired], sites).ok, false);
	assert.deepEqual(checkLinks([retired], sites, [retired]), { ok: true, entries: [retired] });
	assert.deepEqual(checkLinks([{ site: '', handle: 'ada' }], sites), {
		ok: false,
		message: 'choose a site for "ada"'
	});
});

test('the href is built on render, and an entry for a site no longer offered is not rendered', () => {
	const entries = [
		{ site: 'myspace', handle: 'ada' },
		{ site: 'github', handle: 'ada' },
		{ site: 'linkedin', handle: 'bad/handle' }
	];
	const links = renderLinks(entries, [site('linkedin'), site('github')]);
	assert.deepEqual(links, [
		{
			site: 'github',
			handle: 'ada',
			label: 'GitHub',
			icon: 'github',
			href: 'https://github.com/ada'
		}
	]);
	// A custom site whose address changes changes every rendered link and no row.
	const before = { ...custom('https://code.example/{handle}'), id: 'github' };
	const after = { ...custom('https://code.example/u/{handle}'), id: 'github' };
	assert.equal(renderLinks(entries, [before])[0].href, 'https://code.example/ada');
	assert.equal(renderLinks(entries, [after])[0].href, 'https://code.example/u/ada');
	assert.deepEqual(entries[1], { site: 'github', handle: 'ada' });
});

test('a stored list is read as {site, handle} pairs, anything else dropped', () => {
	assert.deepEqual(storedLinks('https://www.linkedin.com/in/ada'), []);
	assert.deepEqual(
		storedLinks([
			{ site: 'github', handle: 'ada' },
			{ site: 'gitlab', handle: 'ada', x: 1 },
			'junk',
			null
		]),
		[{ site: 'github', handle: 'ada' }]
	);
});

test('links text is space-separated site:handle pairs, Mastodon written as stored', () => {
	const entries = [
		{ site: 'linkedin', handle: 'ada' },
		{ site: 'mastodon', handle: 'ada@mastodon.social' },
		{ site: 'website', handle: 'https://example.org/a?b=c#d' }
	];
	assert.equal(
		linksText(entries),
		'linkedin:ada mastodon:ada@mastodon.social website:https://example.org/a?b=c#d'
	);
	assert.deepEqual(parseLinksText(linksText(entries)), { entries, malformed: [] });
	assert.deepEqual(parseLinksText(' linkedin:ada  nopair github: :x '), {
		entries: [{ site: 'linkedin', handle: 'ada' }],
		malformed: ['nopair', 'github:', ':x']
	});
});

test('a skin field offers core sites by id, then its own with the icon served from the root', () => {
	const sites = offeredSites({
		sites: ['github', 'linkedin'],
		custom: [
			{
				id: 'codeberg',
				label: 'Codeberg',
				icon: 'icons/codeberg.svg',
				url: 'https://codeberg.org/{handle}'
			}
		]
	});
	assert.deepEqual(
		sites.map((s) => [s.id, s.icon]),
		[
			['github', 'github'],
			['linkedin', 'linkedin'],
			['codeberg', '/icons/codeberg.svg']
		]
	);
	assert.equal(sites[2].kind, undefined);
	assert.deepEqual(reduceLink(sites[2], 'https://codeberg.org/ada'), { ok: true, handle: 'ada' });
});

test('the reference docs describe links, the request form, the stored list and the icon license', () => {
	const doc = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
	const skin = doc('docs/skin.md');
	const section = skin.split(/^### Links$/m)[1]?.split(/^### /m)[0] ?? '';
	assert.ok(section, 'docs/skin.md has no Links section');
	for (const key of ['`sites`', '`custom`', '`url`', '`wikidata`', '`icon`', '`social-links`']) {
		assert.ok(section.includes(key), `the Links section never names ${key}`);
	}
	for (const s of CORE_SITES) {
		assert.match(
			section,
			new RegExp(`\\| \`${s.id}\`\\s+\\| ${s.label}\\s+\\|[^\\n]*\\| ${s.wikidata}\\s+\\|`),
			s.id
		);
	}
	const features = doc('docs/features.md');
	assert.match(features, /rel="nofollow noopener noreferrer ugc"/);
	assert.match(
		features.split(/^## Membership requests$/m)[1] ?? '',
		/each `links` field the skin declares/
	);
	const model = doc('docs/data-model.md');
	assert.doesNotMatch(model.match(/^- \*\*`member`\*\*:.*$/m)![0], /linkedin/);
	assert.match(model, /\{"site": …, "handle": …\}/);
	const notices = doc('THIRD_PARTY_NOTICES.md');
	assert.match(notices, /^## Font Awesome Free$/m);
	assert.match(notices, /Creative Commons Attribution 4\.0/);
	assert.match(notices, /MIT License/);
	assert.match(notices, /^## social-links$/m);
	assert.match(notices, /Copyright \(c\) 2020 Grzegorz Ku/);
});

test('a custom template is https on one lowercase host with {handle} once, ending a segment', () => {
	for (const url of [
		'https://codeberg.org/{handle}',
		'https://profiles.example/u/{handle}/',
		'https://profiles.example/~{handle}',
		'https://profiles.example/a/@{handle}/b',
		'https://profiles.example/u+{handle}'
	]) {
		assert.equal(templateProblem(url), null, url);
	}
	for (const url of [
		'http://profiles.example/{handle}',
		'https://profiles.example/u',
		'https://profiles.example/{handle}/{handle}',
		'https://{handle}.profiles.example/u',
		'https://profiles.example:8443/{handle}',
		'https://user@profiles.example/{handle}',
		'https://profiles.example/u?name={handle}',
		'https://profiles.example/u#{handle}',
		'https://profiles.example/{handle}?ref=x',
		'https://profiles.example/{handle}x',
		'https://profiles.example/x{handle}',
		'https://profiles.example/u-{handle}',
		'https://profiles.example/a/../{handle}',
		'https://profiles.example/a%20b/{handle}',
		'https://profiles.example/{user}/{handle}',
		'https://Profiles.example/{handle}',
		'https://localhost/{handle}',
		'https://127.0.0.1/{handle}'
	]) {
		assert.notEqual(templateProblem(url), null, url);
	}
});

test('a custom site reads its address with or without scheme, www, query or trailing slash, and the bare handle', () => {
	const s = custom('https://www.profiles.example/u/@{handle}/');
	for (const value of [
		'https://www.profiles.example/u/@Ada/',
		'https://profiles.example/u/@Ada',
		'http://profiles.example/u/@Ada?x=1',
		'profiles.example/u/@Ada',
		'https://www.profiles.example/u/@Ada/#frag',
		'HTTP://PROFILES.example/u/@Ada',
		'@Ada',
		'Ada'
	]) {
		assert.deepEqual(reduceLink(s, value), { ok: true, handle: 'Ada' }, value);
	}
	assert.equal(linkHref(s, 'Ada'), 'https://www.profiles.example/u/@Ada/');
	for (const value of [
		'https://www.profiles.example/u/Ada/',
		'https://www.profiles.example/v/@Ada/',
		'https://www.profiles.example/u/@Ada/x',
		'https://evil.example/u/@Ada/',
		'https://www.profiles.example.evil.example/u/@Ada/',
		'ftp://www.profiles.example/u/@Ada/',
		'@@Ada'
	]) {
		assert.equal(reduceLink(s, value).ok, false, value);
	}
});

test('a custom template is matched as literal text, its dots and other regex characters escaped', () => {
	const dotted = custom('https://codeberg.org/{handle}');
	assert.equal(reduceLink(dotted, 'https://codebergXorg/ada').ok, false);
	const plus = custom('https://profiles.example/u+{handle}');
	assert.deepEqual(reduceLink(plus, 'https://profiles.example/u+ada'), { ok: true, handle: 'ada' });
	assert.equal(reduceLink(plus, 'https://profiles.example/uuada').ok, false);
	assert.equal(linkHref(plus, 'ada'), 'https://profiles.example/u+ada');
});

test('on a custom site a stored handle reduces to itself and links to the template with it in place', () => {
	for (const url of [
		'https://codeberg.org/{handle}',
		'https://profiles.example/u/~{handle}/about',
		'https://www.profiles.example/@{handle}'
	]) {
		const s = custom(url);
		for (const handle of ['a', 'Ada.b-c_9', 'ada.bsky.social', 'josé']) {
			assert.deepEqual(reduceLink(s, handle), { ok: true, handle }, `${url}: ${handle}`);
			const href = linkHref(s, handle)!;
			assert.equal(href, url.replace('{handle}', handle));
			assert.equal(new URL(href).protocol, 'https:', href);
			assert.deepEqual(reduceLink(s, href), { ok: true, handle }, href);
		}
	}
});
