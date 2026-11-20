import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	magicLinkEmailParts,
	stripInvisiblePadding,
	stripJsonLd,
	stripRemoteFontLinks
} from './magic-link-message';
import { MAGIC_LINK_EMAIL_HTML as RAW } from './magic-link-template';
import { currentSkin } from '../skin/load';

// This message reached a Gmail spam folder. Auth was clean (SPF, DKIM, DMARC all
// pass), so what remained was the shape of the thing: 7 KB of markup around 287
// bytes of prose, 900 bytes of invisible padding, three third-party font
// requests, and no plain-text alternative. Each test below pins one of those.

// The deployment's strings as sendMagicLinkEmail passes them, from the running
// (default) skin.
const { site, mail, brand } = currentSkin().skin;
const { theme } = currentSkin();
const SITE = {
	baseUrl: `https://www.${site.domain}`,
	emailLogo: brand.email_logo,
	accent: theme.light.accent,
	accentContrast: theme.light.accentContrast,
	subject: mail.sign_in_subject,
	siteName: site.name,
	signature: mail.signature,
	credit: mail.credit
};
const URL = `https://www.${site.domain}/auth/magic?token=abc123`;
const parts = () => magicLinkEmailParts(URL, SITE);

test('the vendored template still carries what we strip', () => {
	// If this fails the template was re-rendered and the strips may now be
	// no-ops silently protecting nothing. That is the failure worth catching.
	assert.ok((RAW.match(/&#847;/g) ?? []).length > 50, 'padding gone from the source template');
	assert.match(RAW, /application\/ld\+json/, 'ld+json gone from the source template');
});

test('a message is composed in both representations', () => {
	const { subject, text, html } = parts();
	assert.ok(subject.length > 0);
	assert.ok(text.length > 0, 'no plain-text alternative was produced');
	assert.ok(html.length > 0);
});

// The point of the plain part: a reader with no HTML must still be able to sign
// in. A version that omitted the link would look fine and be useless.
test('the plain-text part carries the sign-in URL verbatim', () => {
	assert.ok(parts().text.includes(URL));
});

test('the plain-text part is prose, not stripped markup', () => {
	const { text } = parts();
	assert.ok(!text.includes('<'), 'markup leaked into the plain part');
	assert.match(text, /Confirm your email address/);
	assert.match(text, /ignore this email/);
});

test("E41 R2: subject, title, label, logo alt and signature are the skin's, in both parts", () => {
	const { subject, text, html } = magicLinkEmailParts(URL, {
		...SITE,
		subject: 'Your Chess Club sign-in link',
		siteName: 'Chess Club',
		signature: 'The Chess Club'
	});
	assert.equal(subject, 'Your Chess Club sign-in link');
	assert.ok(text.startsWith('Your Chess Club sign-in link\n'));
	assert.ok(text.endsWith('Thanks,\nThe Chess Club'));
	assert.match(html, /<title>Your Chess Club sign-in link<\/title>/);
	assert.match(html, /aria-label="Your Chess Club sign-in link"/);
	assert.match(html, /alt="Chess Club"/);
	assert.match(html, />The Chess Club<\/a>/);
	// The defaults reach the message the same way.
	assert.equal(parts().subject, mail.sign_in_subject);
});

test('E41 R2: a skin string is text in the HTML, never markup or a sentinel', () => {
	const { html } = magicLinkEmailParts(URL, {
		...SITE,
		siteName: 'A "B" <i>&',
		signature: '%%MAGIC_LINK%%'
	});
	assert.match(html, /alt="A &quot;B&quot; &lt;i&gt;&amp;"/);
	assert.ok(html.includes('>%%MAGIC_LINK%%</a>'), 'a sentinel inside skin text was expanded');
});

// 150 invisible characters is what a content filter reads as hidden text, which
// is the pattern those filters were built for.
test('the invisible preheader padding is gone', () => {
	assert.equal((parts().html.match(/&#847;/g) ?? []).length, 0);
});

// Stripping the padding must not take the preheader with it: the sentence is
// the reason the block exists.
test('the visible preheader survives the padding strip', () => {
	assert.match(parts().html, /Is this what you are looking for\?/);
});

test('stripping padding leaves surrounding text untouched', () => {
	assert.equal(
		stripInvisiblePadding('<div>Keep me &#847; &#847; &#847; </div>'),
		'<div>Keep me </div>'
	);
	assert.equal(stripInvisiblePadding('<div>no padding here</div>'), '<div>no padding here</div>');
});

// Upstream requests Roboto Slab and never applies it: every font-family in the
// template names Segoe UI or the system stack. The vendored copy leaves the
// three tags out, so what these pin is that a re-render cannot bring them back.
const UPSTREAM_FONT_LINKS = [
	'  <link rel="preconnect" href="https://fonts.example.net">',
	'  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
	'  <link href="https://fonts.example.net/css2?family=Roboto+Slab:wght@400;600&display=swap" rel="stylesheet">'
];
const FONT_HOST_LINK = /<link\b[^>]*\/\/fonts\./g;

test('the vendored template and the sent HTML request no font host', () => {
	assert.equal((RAW.match(FONT_HOST_LINK) ?? []).length, 0, 'the template links a font host');
	assert.equal((parts().html.match(FONT_HOST_LINK) ?? []).length, 0);
});

test('font links a re-render brings back are stripped, and only those lines', () => {
	const title = '  <title>%%SUBJECT%%</title>\n';
	assert.ok(RAW.includes(`${title}  <style>`), 'the template head changed shape');
	const rerendered = RAW.replace(title, `${title}${UPSTREAM_FONT_LINKS.join('\n')}\n`);
	assert.equal((rerendered.match(FONT_HOST_LINK) ?? []).length, 3);
	assert.equal(stripRemoteFontLinks(rerendered), RAW);
});

test('no font-family in the sent HTML referenced the removed face', () => {
	assert.ok(
		!/font-family:[^;"]*Roboto/i.test(parts().html),
		'a rule used the face we stopped loading'
	);
});

test('a link tag to anywhere else is left alone', () => {
	for (const keep of [
		'  <link rel="stylesheet" href="https://example.com/a.css">\n',
		'  <link rel="stylesheet" href="https://example.com/fonts.css">\n',
		'  <link rel="icon" href="https://cdn.example.com/fonts.example.net/a.png">\n'
	]) {
		assert.equal(stripRemoteFontLinks(keep), keep);
	}
});

// Gmail is the only client that acts on a schema.org annotation and requires
// the sender to be registered first, so the block does nothing wherever it
// lands. What it does do is put a <script> element in a message.
test('no script element survives into the sent HTML', () => {
	assert.equal((parts().html.match(/<script\b/gi) ?? []).length, 0);
	assert.equal((parts().html.match(/application\/ld\+json/gi) ?? []).length, 0);
});

// The annotation named the template's author as publisher while From: is this
// deployment's domain. A filter parsing both sees two organisations.
test('the ld+json publisher is gone', () => {
	assert.ok(!/"publisher"/.test(parts().html), 'the structured publisher claim survived');
});

test('E41 R2: the "secured by" credit is the skin\'s, and absent renders nothing', () => {
	const credited = magicLinkEmailParts(URL, {
		...SITE,
		credit: { name: 'Sign Co', url: 'https://sign.example.net/' }
	}).html;
	assert.match(
		credited,
		/Sign-in secured by\s*<a href="https:\/\/sign\.example\.net\/"[^>]*>Sign Co<\/a>/
	);
	const bare = magicLinkEmailParts(URL, { ...SITE, credit: undefined }).html;
	assert.ok(!bare.includes('secured by'), 'a credit line rendered with no credit set');
	assert.ok(!bare.includes('%%CREDIT%%'));
});

// The sentinel appears twice inside the annotation. Stripping the block after
// substitution must not take the button's href with it.
test('stripping the annotation leaves the sign-in link intact', () => {
	const { html } = parts();
	assert.ok(html.includes(URL), 'the sign-in URL went with the ld+json block');
	assert.ok(!/"potentialAction"/.test(html));
});

test('the ld+json strip takes only that script', () => {
	const keep = '  <script type="text/javascript">var a = 1;</script>\n';
	assert.equal(stripJsonLd(keep), keep);
	assert.equal(stripJsonLd('<p>plain</p>'), '<p>plain</p>');
});

test('the sign-in URL is substituted and no sentinel survives', () => {
	const { html } = parts();
	assert.ok(html.includes(URL));
	assert.ok(!/%%[A-Z_]+%%/.test(html), 'an unreplaced sentinel would email a dead link');
});

// The template used to name two other sites' hosts, rewritten at send time.
// It now names none, so nothing has to be rewritten and nothing can be missed.
test("E41 R2: the template names no host, and every link and the logo are the deployment's", () => {
	const hosts = RAW.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
	assert.deepEqual(
		hosts.filter((h) => h !== 'http://schema.org'),
		[],
		'the template links a host of its own'
	);
	const { html } = magicLinkEmailParts(URL, { ...SITE, baseUrl: 'https://staging.example.org' });
	assert.ok(html.includes('src="https://staging.example.org/email/shared/'));
	assert.ok(html.includes('href="https://staging.example.org/?utm_source=login"'));
});
