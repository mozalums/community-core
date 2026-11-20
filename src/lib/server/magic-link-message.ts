// The sign-in message, composed from the vendored template.
//
// Pure: no $env, no SvelteKit. `$lib/site` reads `$env/dynamic/public`, which
// resolves only under Vite, so the deployment's own strings are passed in and
// this module stays loadable by a test. Same shape as sync-core.ts, and for the
// same reason: the interesting logic is the part worth testing, so it must not
// be the part that needs a bundler to load.
//
// The template carries sentinels for every deployment string; they are filled
// here. The deliverability edits below (padding, font links, JSON-LD) also
// happen here rather than in the template, so a re-render from the Maizzle
// source cannot quietly bring back what they remove.

import { MAGIC_LINK_EMAIL_HTML } from '$lib/server/magic-link-template';

// `&#847;` is U+034F, a combining grapheme joiner, and renders as nothing. The
// template pads the preheader with 150 of them so a client's preview snippet
// stops after the intended sentence instead of running on into the body.
//
// 900 bytes of text nobody can see is also, to a content filter, indistinguishable
// from the hidden text those filters exist to catch. The visible preheader
// sentence is kept; only the padding goes, so the preview still reads correctly
// and there is simply less of it.
const INVISIBLE_PADDING = /(?:&#847;\s*)+/g;

// The upstream template preconnects to Google Fonts and pulls Roboto Slab.
// Nothing selects it: every `font-family` in the file names 'Segoe UI' or the
// ui-sans-serif system stack. Three requests to a third party for a typeface the
// message never applies, so removing them changes no rendering.
//
// The vendored copy already leaves the three tags out. This stays so a
// re-render from the Maizzle source cannot put the requests back in a sent
// message, and it matches any `fonts.` host because the next font CDN would be
// the same three requests under another name.
const REMOTE_FONT_LINK =
	/^[ \t]*<link\b[^>]*\bhref=["']https?:\/\/fonts\.[^"'\/]+[^"']*["'][^>]*>[ \t]*\r?\n?/gm;

// A schema.org EmailMessage annotation. Gmail is the only client that would act
// on one and it requires the sender to be registered first, so the block is
// inert everywhere it lands — while presenting a <script> element inside a
// message, which is the shape mail filters are built to distrust.
//
// Its `publisher` also names the template's author in a message whose From: is
// this deployment's own domain. Structured data asserting a different
// organisation than the envelope reads as a mismatch to anything that parses
// it. A skin that wants to credit the author says so in `mail.credit`.
const LD_JSON_BLOCK =
	/^[ \t]*<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?/gim;

export type MagicLinkParts = { subject: string; text: string; html: string };

/** The deployment's own strings: its origin, the skin's mail identity and look. */
export type MagicLinkSite = {
	baseUrl: string;
	/** Path of the logo under baseUrl, no leading slash. */
	emailLogo: string;
	accent: string;
	accentContrast: string;
	subject: string;
	siteName: string;
	signature: string;
	credit?: { name: string; url: string };
};

const escapeHtml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Drop the invisible preheader padding, keeping the preheader itself. */
export function stripInvisiblePadding(html: string): string {
	return html.replace(INVISIBLE_PADDING, '');
}

/** Drop `<link>` requests to a font host, for a face no rule in the template uses. */
export function stripRemoteFontLinks(html: string): string {
	return html.replace(REMOTE_FONT_LINK, '');
}

/** Drop the inert schema.org annotation, and the <script> element carrying it. */
export function stripJsonLd(html: string): string {
	return html.replace(LD_JSON_BLOCK, '');
}

/**
 * Both representations of the sign-in message, from one URL.
 *
 * The plain-text half is written rather than derived. The template is 7 KB of
 * markup around under 300 bytes of prose, so anything mechanical would produce
 * wreckage; a sign-in mail has one sentence and one link, and saying them
 * plainly makes a better alternative part than any converter would.
 *
 * It is not optional politeness. An HTML-only transactional message leaves
 * nothing for a client that will not render HTML, nothing for a filter deciding
 * whether 7 KB of markup deserves trust, and nothing in a bounce report — and
 * this message reached a Gmail spam folder.
 */
export function magicLinkEmailParts(url: string, site: MagicLinkSite): MagicLinkParts {
	const credit = site.credit
		? `                      <p style="font-size: 11px">\n` +
			`                        Sign-in secured by\n` +
			`                        <a href="${escapeHtml(site.credit.url)}" style="text-decoration-line: underline">${escapeHtml(site.credit.name)}</a>.\n` +
			`                      </p>\n`
		: '';
	const values: Record<string, string> = {
		MAGIC_LINK: url,
		BASE_URL: site.baseUrl,
		EMAIL_LOGO: escapeHtml(site.emailLogo),
		ACCENT: escapeHtml(site.accent),
		ACCENT_CONTRAST: escapeHtml(site.accentContrast),
		SUBJECT: escapeHtml(site.subject),
		SITE_NAME: escapeHtml(site.siteName),
		SIGNATURE: escapeHtml(site.signature),
		CREDIT: credit
	};
	// One pass, so a sentinel spelled inside a skin's own text stays text.
	const html = stripJsonLd(
		stripRemoteFontLinks(
			stripInvisiblePadding(
				MAGIC_LINK_EMAIL_HTML.replace(/%%([A-Z_]+)%%/g, (whole, name: string) =>
					Object.hasOwn(values, name) ? values[name] : whole
				)
			)
		)
	);

	const text = [
		site.subject,
		'',
		'Confirm your email address by opening this link:',
		'',
		url,
		'',
		"If you don't know what this is about, please ignore this email.",
		'',
		'Thanks,',
		site.signature
	].join('\n');

	return { subject: site.subject, text, html };
}
