// A member's links to their profiles on other sites. Core defines how each
// site works; a skin picks which a community offers and may add its own
// (src/lib/skin/schema.ts, field type `links`). The server's check is the only
// one that counts; the edit form runs the same reduction as a convenience.
//
// A member stores a handle, never a URL, and the address is built on every
// render, so a site changing its URL form is a one-line change here.
//
// `social-links` decides what a profile address or bare id looks like on each
// site and what address an id renders as. Core adds the sites it lacks
// (GitLab, Bluesky, an @handle-only YouTube, a skin's own) as profiles of the
// same instance, and keeps two readers of its own: Mastodon, whose handle names
// any instance, and the website, which is a whole address.

import { SocialLinks, TYPE_DESKTOP, type ProfileMatch } from 'social-links';

type SiteBase = {
	// Lowercase slug a stored entry names its site by.
	id: string;
	label: string;
	// Core: a Font Awesome Free glyph name (site-glyphs.ts). A skin's own site:
	// the root-relative URL its icon is served at.
	icon: string;
	// The Wikidata property for the identifier the handle is.
	wikidata?: string;
};

// A handle read and rendered by `social-links`: core's sites name the library
// profiles that read a pasted value, the first of them renders; a skin's own
// site gives its address template, which becomes a profile on first use.
export type TemplateSite = SiteBase & { kind?: undefined } & (
		| { profiles: readonly string[]; url?: undefined }
		| { url: string; profiles?: undefined }
	);

// `user@instance`, rendered as https://instance/@user.
export type MastodonSite = SiteBase & { kind: 'mastodon' };

// One full https:// address, stored as URL parsing serializes it.
export type WebsiteSite = SiteBase & { kind: 'website' };

export type SiteDef = TemplateSite | MastodonSite | WebsiteSite;

export type LinkEntry = { site: string; handle: string };

export type RenderedLink = LinkEntry & { label: string; icon: string; href: string };

// The longest website address kept, the limit browsers and sitemaps use.
export const MAX_LINK_LENGTH = 2048;

const MAX_HANDLE_LENGTH = 100;

const links = new SocialLinks({ allowQueryParams: true });

const HOLE = '{handle}';
const ID = '{PROFILE_ID}';

// A profile reading `https://[www.]<host><path>{id}` and the bare id, rendered
// as `render`. The bare form may carry the prefix the address puts before the
// id, like YouTube's @.
function addressProfile(
	name: string,
	address: string,
	render: string,
	barePrefix = ''
): ProfileMatch[] {
	const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
	const [before, after] = address.split(ID);
	const head = before.replace(/^https:\/\/(www\.)?/, '');
	const matches: ProfileMatch[] = [
		{
			match: `(?:https?://)?(?:www\\.)?${esc(head)}(${ID})${esc(after.replace(/\/$/, ''))}/?`,
			group: 1,
			type: TYPE_DESKTOP,
			pattern: render
		},
		{ match: `${barePrefix ? `(?:${esc(barePrefix)})?` : ''}(${ID})`, group: 1 }
	];
	links.addProfile(name, matches);
	return matches;
}

addressProfile('gitlab', 'https://gitlab.com/{PROFILE_ID}', 'https://gitlab.com/{PROFILE_ID}');
addressProfile(
	'bluesky',
	'https://bsky.app/profile/{PROFILE_ID}',
	'https://bsky.app/profile/{PROFILE_ID}',
	'@'
);
// The library's own youtube profile also reads /channel/ and /user/ addresses
// and renders their ids as @handles, which names a different channel.
addressProfile(
	'youtube-handle',
	'https://youtube.com/@{PROFILE_ID}',
	'https://youtube.com/@{PROFILE_ID}',
	'@'
);

export const CORE_SITES: readonly SiteDef[] = [
	{
		id: 'linkedin',
		label: 'LinkedIn',
		icon: 'linkedin',
		profiles: ['linkedin'],
		wikidata: 'P6634'
	},
	{ id: 'github', label: 'GitHub', icon: 'github', profiles: ['github'], wikidata: 'P2037' },
	{ id: 'gitlab', label: 'GitLab', icon: 'gitlab', profiles: ['gitlab'], wikidata: 'P8827' },
	{ id: 'mastodon', label: 'Mastodon', icon: 'mastodon', wikidata: 'P4033', kind: 'mastodon' },
	{ id: 'bluesky', label: 'Bluesky', icon: 'bluesky', profiles: ['bluesky'], wikidata: 'P12361' },
	{
		id: 'instagram',
		label: 'Instagram',
		icon: 'instagram',
		profiles: ['instagram'],
		wikidata: 'P2003'
	},
	{ id: 'x', label: 'X', icon: 'x-twitter', profiles: ['x', 'twitter'], wikidata: 'P2002' },
	{
		id: 'youtube',
		label: 'YouTube',
		icon: 'youtube',
		profiles: ['youtube-handle'],
		wikidata: 'P11245'
	},
	{ id: 'website', label: 'Website', icon: 'globe', wikidata: 'P856', kind: 'website' }
];

export const CORE_SITE_IDS: readonly string[] = CORE_SITES.map((s) => s.id);

export function coreSite(id: string): SiteDef | undefined {
	return CORE_SITES.find((s) => s.id === id);
}

// A skin's links field as the sites it offers, in menu order: core's by id,
// then the skin's own, each a template site with its icon served from the
// site root.
export function offeredSites(field: {
	sites?: readonly string[];
	custom?: readonly { id: string; label: string; icon: string; url: string; wikidata?: string }[];
}): SiteDef[] {
	return [
		...(field.sites ?? []).flatMap((id) => coreSite(id) ?? []),
		...(field.custom ?? []).map((c): TemplateSite => ({ ...c, icon: `/${c.icon}` }))
	];
}

// A dotted host name of lowercase letters, digits and hyphens that URL parsing
// returns unchanged: no IDNA rewrite, and not an IPv4 address.
function dnsHost(host: string): boolean {
	if (host.length > 253 || !/^[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/.test(host)) return false;
	if (/^(?:\d+|0x[0-9a-f]*)$/.test(host.slice(host.lastIndexOf('.') + 1))) return false;
	try {
		return new URL(`https://${host}/`).hostname === host;
	} catch {
		return false;
	}
}

// Null for a usable custom-site template, else the form it should take. The
// skin loader refuses a custom site at boot on this. The template text is the
// rendered address with the id dropped in, so URL parsing must leave it as
// written, and a fixed prefix before {handle} must hold a character no id can,
// or stripping it from a bare value would eat the start of a real handle.
export function templateProblem(url: string): string | null {
	if (!url.startsWith('https://')) return 'an address starting with https://';
	if (url.split(HOLE).length !== 2 || /[{}]/.test(url.replace(HOLE, ''))) {
		return 'an address holding {handle} exactly once';
	}
	const rest = url.slice('https://'.length);
	const slash = rest.indexOf('/');
	const host = slash < 0 ? rest : rest.slice(0, slash);
	if (slash < 0 || host.includes(HOLE)) return 'an address with {handle} in its path';
	if (!dnsHost(host))
		return 'an address on one lowercase, dotted host name, with no port or credentials';
	const segment = rest
		.slice(slash + 1)
		.split('/')
		.find((s) => s.includes(HOLE))!;
	if (!segment.endsWith(HOLE)) {
		return 'an address with {handle} ending its path segment, after at most a fixed prefix';
	}
	const prefix = segment.slice(0, -HOLE.length);
	if (prefix && !/[^A-Za-z0-9_.%\u0080-\uffff-]/.test(prefix)) {
		return "an address whose prefix before {handle} holds a character no handle can, like YouTube's @";
	}
	const sample = url.replace(HOLE, 'x');
	if (/[?#%]/.test(url) || !URL.canParse(sample) || new URL(sample).href !== sample) {
		return 'an address with no query, fragment, escape, space or dot segment';
	}
	return null;
}

// The library profiles reading a template site, registering a skin's own the
// first time it is used here (the server and each browser hold one instance).
function profilesOf(site: TemplateSite): readonly string[] {
	if (site.profiles) return site.profiles;
	const name = `skin ${site.url}`;
	if (!links.hasProfile(name) && templateProblem(site.url) === null) {
		const render = site.url.replace(HOLE, ID);
		const segment = site.url.split('/').find((s) => s.includes(HOLE))!;
		addressProfile(name, render, render, segment.slice(0, -HOLE.length));
	}
	return links.hasProfile(name) ? [name] : [];
}

// What the library's id class admits that a stored handle must not hold:
// whitespace, controls, lone surrogates and the noncharacters U+FFFE/U+FFFF
// (PostgreSQL jsonb refuses a lone surrogate, and the links CSV cell splits on
// whitespace), and an all-dot id, which URL parsing reads as a dot segment.
function storable(id: string): boolean {
	return (
		id.length > 0 &&
		id.length <= MAX_HANDLE_LENGTH &&
		!/[\s\p{Cc}\p{Cs}\ufffe\uffff]/u.test(id) &&
		!/^(?:\.|%2e)+$/i.test(id)
	);
}

// A pasted address with its scheme and host lowercased and its fragment
// dropped: the library's patterns match neither capitals there nor a
// fragment, and a browser's address bar gives members both. The path is left
// as typed, so a non-ASCII handle reads back as the same text.
function canonicalAddress(value: string): string {
	return value.replace(/^(https?:\/\/[^/?#]*)/i, (m) => m.toLowerCase()).replace(/#.*$/s, '');
}

function templateHandle(site: TemplateSite, raw: string): string | null {
	const value = canonicalAddress(raw);
	const [render, ...rest] = profilesOf(site);
	if (!render) return null;
	for (const name of [render, ...rest]) {
		if (!links.isValid(name, value)) continue;
		const id = links.getProfileId(name, value);
		// A match whose canonical address is not the one the id renders as
		// names another page: a LinkedIn company, a mobile-only host.
		if (!storable(id) || links.sanitize(name, value) !== links.getLink(render, id)) continue;
		return id;
	}
	return null;
}

const MASTODON_USER = /^[A-Za-z0-9_]+(?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

function mastodonHandle(value: string): string | null {
	const m = /^@?([^@]+)@([^@]+)$/.exec(value);
	if (!m || !MASTODON_USER.test(m[1]) || m[1].length > MAX_HANDLE_LENGTH) return null;
	// Checked before folding: toLowerCase maps some non-ASCII letters, such as
	// the Kelvin sign, onto ASCII ones.
	if (!/^[A-Za-z0-9.-]+$/.test(m[2])) return null;
	const instance = m[2].toLowerCase();
	return dnsHost(instance) ? `${m[1]}@${instance}` : null;
}

// The rules a bio link follows (src/lib/server/profile-url.ts): https://
// assumed when no scheme is given, https only, a dotted host, no credentials.
function websiteHref(value: string): string | null {
	// URL parsing silently drops tabs and newlines and replaces a lone
	// surrogate, either of which would store an address the member never wrote.
	if (/[\u0000-\u001f\u007f\s\ud800-\udfff]/u.test(value)) return null;
	const address = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
	// `https:host` and `https:/host` parse alone but resolve against the page
	// when used as an href, so the authority must be spelled out.
	if (!/^https:\/\/[^/\\?#]/i.test(address)) return null;
	if (address.length > MAX_LINK_LENGTH || !URL.canParse(address)) return null;
	const url = new URL(address);
	if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
	if (url.username || url.password || url.href.length > MAX_LINK_LENGTH) return null;
	return url.href;
}

// How an error names what the site expects: "the part after linkedin.com/in/".
export function expectedForm(site: SiteDef): string {
	if (site.kind === 'mastodon') return '@user@instance';
	if (site.kind === 'website') return 'an https:// address';
	const [render] = profilesOf(site);
	if (!render) return 'a handle';
	const before = links.getLink(render, HOLE).split(HOLE)[0];
	return `the part after ${before.replace(/^https:\/\/(www\.)?/, '')}`;
}

export type LinkCheck = { ok: true; handle: string } | { ok: false; message: string };

// A value as typed or pasted, reduced to the handle the site stores. Called
// where a value enters: the edit form, the request form and CSV import.
export function reduceLink(site: SiteDef, raw: string): LinkCheck {
	const value = raw.trim();
	const handle =
		site.kind === 'mastodon'
			? mastodonHandle(value)
			: site.kind === 'website'
				? websiteHref(value)
				: templateHandle(site, value);
	return handle === null
		? { ok: false, message: `${site.label}: ${expectedForm(site)}` }
		: { ok: true, handle };
}

// The address a stored handle links to, or null when the site would not store
// that handle today. Rendering never rewrites: a row written before a rule
// tightened shows unlinked instead.
export function linkHref(site: SiteDef, handle: string): string | null {
	const c = reduceLink(site, handle);
	if (!c.ok || c.handle !== handle) return null;
	if (site.kind === 'website') return handle;
	if (site.kind === 'mastodon') {
		const [user, instance] = handle.split('@');
		return `https://${instance}/@${user}`;
	}
	return links.getLink(profilesOf(site)[0], handle);
}

const isEntry = (e: unknown): e is LinkEntry =>
	e !== null &&
	typeof e === 'object' &&
	!Array.isArray(e) &&
	Object.keys(e).length === 2 &&
	typeof (e as LinkEntry).site === 'string' &&
	typeof (e as LinkEntry).handle === 'string';

// The entries stored under a links field; anything else in the value is ignored.
export function storedLinks(value: unknown): LinkEntry[] {
	return Array.isArray(value)
		? value.filter(isEntry).map(({ site, handle }) => ({ site, handle }))
		: [];
}

// Whether a value is a links list when no field type is at hand: a non-empty
// array of exactly {site, handle} string pairs. The search index applies the
// same test in SQL (member_is_links, migration 22).
export function isLinkList(value: unknown): value is LinkEntry[] {
	return Array.isArray(value) && value.length > 0 && value.every(isEntry);
}

// The CSV cell and no-JavaScript form: `site:handle` pairs, space separated.
// No accepted handle holds whitespace, so no quoting is needed.
export function linksText(entries: readonly LinkEntry[]): string {
	return entries.map((e) => `${e.site}:${e.handle}`).join(' ');
}

// The inverse of linksText. Each pair splits at its first colon, so the
// website's `https://...` stays whole. Validation is the caller's.
export function parseLinksText(text: string): { entries: LinkEntry[]; malformed: string[] } {
	const entries: LinkEntry[] = [];
	const malformed: string[] = [];
	for (const pair of text.split(/\s+/u).filter(Boolean)) {
		const colon = pair.indexOf(':');
		if (colon < 1 || colon === pair.length - 1) malformed.push(pair);
		else entries.push({ site: pair.slice(0, colon), handle: pair.slice(colon + 1) });
	}
	return { entries, malformed };
}

// Every entry reduced against the sites a field offers, at most one per site.
// An entry for a site the field no longer offers is kept only when `keep`
// holds that exact entry already, so a member's save never drops it.
export function checkLinks(
	entries: readonly LinkEntry[],
	sites: readonly SiteDef[],
	keep: readonly LinkEntry[] = []
): { ok: true; entries: LinkEntry[] } | { ok: false; message: string } {
	const out: LinkEntry[] = [];
	const seen = new Set<string>();
	for (const e of entries) {
		if (!e.site) return { ok: false, message: `choose a site for "${e.handle}"` };
		const site = sites.find((s) => s.id === e.site);
		if (seen.has(e.site))
			return { ok: false, message: `${site?.label ?? e.site}: only one link per site` };
		seen.add(e.site);
		if (!site) {
			if (keep.some((k) => k.site === e.site && k.handle === e.handle)) {
				out.push({ site: e.site, handle: e.handle });
				continue;
			}
			return { ok: false, message: `"${e.site}" is not a site this community offers` };
		}
		const c = reduceLink(site, e.handle);
		if (!c.ok) return c;
		out.push({ site: e.site, handle: c.handle });
	}
	return { ok: true, entries: out };
}

// The stored entries a field still offers, each with its address. An entry
// whose site is gone, or whose handle no longer passes, stays stored unshown.
export function renderLinks(
	entries: readonly LinkEntry[],
	sites: readonly SiteDef[]
): RenderedLink[] {
	return entries.flatMap((e) => {
		const site = sites.find((s) => s.id === e.site);
		const href = site && linkHref(site, e.handle);
		return site && href ? [{ ...e, label: site.label, icon: site.icon, href }] : [];
	});
}
