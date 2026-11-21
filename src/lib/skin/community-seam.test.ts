import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';
import { COPY_NAMES, hasSkinCopy, skinCopy } from '../server/skin-copy';
import { currentSkin } from './load';

// Everything that names or addresses one community comes from the skin: its
// identity, its mail, its copy and documents, its analytics. The suite runs on
// skin/default, so a literal left behind in platform code shows up here as the
// other community's name on a page that should read "Example Community".

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const { site, mail, analytics } = currentSkin().skin;

// The SvelteKit virtual modules resolve to stand-ins reading process.env, as
// adapter-node fills them in production.
register(
	'data:text/javascript,' +
		encodeURIComponent(`
  const stubs = {
    '$env/dynamic/private': 'export const env = process.env;',
    '$env/dynamic/public': 'export const env = process.env;'
  };
  export async function resolve(specifier, context, next) {
    if (specifier in stubs) return {
      url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]),
      shortCircuit: true
    };
    return next(specifier, context);
  }
`),
	import.meta.url
);

const GROUP = {
	id: 'g1',
	slug: site.default_group,
	name: site.name,
	landingMd: null,
	status: 'active'
};
mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/members', {
	namedExports: {
		resolveMember: async () => ({ member: null, firstLogin: false }),
		countMembers: async () => 0,
		listPublicMembers: async () => []
	}
});
mock.module('$lib/server/avatars', { namedExports: { avatarIdFor: async () => null } });
// The Mailgun API boundary, recording what would leave over HTTP.
const mailgunSent: Record<string, unknown>[] = [];
mock.module('mailgun.js', {
	defaultExport: class {
		client() {
			return {
				messages: {
					create: async (_domain: string, message: Record<string, unknown>) => {
						mailgunSent.push(message);
					}
				}
			};
		}
	}
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loader = (event: any) => Promise<any>;
const loader = async (rel: string): Promise<Loader> =>
	(await import(join(ROOT, rel))).load as Loader;
const event = (path: string, user: unknown = null) => ({
	params: { slug: site.default_group },
	url: new URL(`https://www.${site.domain}${path}`),
	locals: { user },
	parent: async () => ({ member: null, isGroupAdmin: false })
});

// ---------------------------------------------------------------------------
// 1: site identity
// ---------------------------------------------------------------------------

test("E41 R1: the default group slug is the skin's, and the clean URLs route to it", async () => {
	assert.equal(site.default_group, 'example');
	const { DEFAULT_GROUP_SLUG } = await import('../group-nav');
	assert.equal(DEFAULT_GROUP_SLUG, site.default_group);
	const { reroute } = await import('../../hooks');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	assert.equal(reroute({ url: new URL('https://x/members') } as any), '/group/example/members');
});

test('E41 R1: the document title and every sign-in surface name the site from the skin', () => {
	assert.equal(site.name, 'Example Community');
	assert.doesNotMatch(read('src/app.html'), /<title>/, 'app.html carries a fixed title');
	assert.match(read('src/routes/+layout.svelte'), /<title>\{site\.name\}<\/title>/);

	const modal = read('src/lib/components/LoginModal.svelte');
	assert.match(modal, /aria-label="Sign in to \{site\.name\}"/);
	assert.match(modal, /alt=\{site\.name\}/);
	assert.match(modal, />Sign in to \{site\.name\}<\/h2>/);
	for (const page of [
		'src/routes/(auth)/login/+page.svelte',
		'src/routes/(auth)/auth/magic/+page.svelte'
	]) {
		const src = read(page);
		assert.match(src, /<title>Sign in — \{site\.name\}<\/title>/, page);
		assert.match(src, /alt=\{site\.name\}/, page);
	}
	assert.match(read('src/routes/(auth)/login/+page.svelte'), />Sign in to \{site\.name\}<\/h1>/);
	for (const f of [
		'src/lib/components/LoginModal.svelte',
		'src/routes/(auth)/login/+page.svelte',
		'src/routes/(auth)/auth/magic/+page.svelte',
		'src/app.html'
	]) {
		assert.doesNotMatch(read(f), /Moz|Alums/, `${f} still names a community`);
	}
});

// ---------------------------------------------------------------------------
// 2: mail identity
// ---------------------------------------------------------------------------

test('E41 R2: both messages take their From name from the skin, and the sign-in message every string', () => {
	const email = read('src/lib/server/email.ts');
	assert.equal((email.match(/fromName: mail\.from_name,/g) ?? []).length, 4);
	assert.match(
		email,
		/subject: mail\.sign_in_subject,\s*siteName: site\.name,\s*signature: mail\.signature,\s*credit: mail\.credit/
	);
	assert.doesNotMatch(email, /Moz|Alums|alumni/);
	assert.equal(mail.credit, undefined, 'the default skin credits nobody');

	const template = read('src/lib/server/magic-link-template.ts');
	assert.doesNotMatch(template, /MAGIC_LINK_EMAIL_SUBJECT|Sign-in secured by|lorem\.host/);
	// Nothing left to rewrite at send time.
	assert.doesNotMatch(read('src/lib/server/magic-link-message.ts'), /replaceAll\('https?:/);
});

test('E41 R2: the Mailgun transport puts the skin display name in From, quoted, with no raw CR/LF', async () => {
	const saved = { ...process.env };
	Object.assign(process.env, {
		MAIL_TRANSPORT: 'mailgun',
		MAIL_DOMAIN: 'mg.example.org',
		MAILGUN_PRIVATE: 'test-no-network'
	});
	try {
		mailgunSent.length = 0;
		const { sendMail } = await import('../server/mail');
		await sendMail({
			fromName: mail.from_name,
			to: ['a@example.org'],
			subject: 's',
			text: 't',
			tag: 'login'
		});
		await sendMail({
			fromName: 'A "quoted", name',
			to: ['a@example.org'],
			subject: 's',
			text: 't',
			tag: 'approved'
		});
		assert.equal(mailgunSent[0].from, `"${mail.from_name}" <no-reply@mg.example.org>`);
		assert.equal(mailgunSent[0]['h:Sender'], undefined);
		assert.equal(
			mailgunSent[0]['o:tracking-clicks'],
			'no',
			'a tracked link breaks the sign-in token'
		);
		assert.equal(mailgunSent[1].from, '"A quoted, name" <no-reply@mg.example.org>');
		// A control character takes the encoded-word branch, so it reaches the
		// header base64-encoded and cannot start a header of its own.
		await sendMail({
			fromName: 'x\r\nBcc: b@example.org',
			to: ['a@example.org'],
			subject: 's',
			text: 't',
			tag: 'login'
		});
		assert.match(
			String(mailgunSent[2].from),
			/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <no-reply@mg\.example\.org>$/
		);
	} finally {
		process.env = saved;
	}
});

test('E41 R2: a Mailgun transport with no MAIL_DOMAIN refuses, naming the variable; there is no borrowed default', async () => {
	const { assertMailConfig, mailgunDomain } = await import('../server/mail');
	assert.throws(() => assertMailConfig({ MAIL_TRANSPORT: 'mailgun' }), /needs MAIL_DOMAIN/);
	assert.throws(
		() => assertMailConfig({ MAIL_TRANSPORT: 'mailgun', MAIL_DOMAIN: '  ' }),
		/MAIL_DOMAIN/
	);
	assert.equal(mailgunDomain({ MAIL_DOMAIN: 'mg.example.org' }), 'mg.example.org');
	assert.doesNotThrow(() => assertMailConfig({}));
	assert.doesNotThrow(() => assertMailConfig({ MAIL_TRANSPORT: 'smtp' }));
	assert.doesNotMatch(read('src/lib/server/mail.ts'), /MAIL_DOMAIN \|\||ident\.agency/);
});

test('E41 R2: the server checks the mail config at load, before the schema step, and lets it stop the process', () => {
	const hooks = read('src/hooks.server.ts');
	const check = hooks.indexOf('assertMailConfig();');
	assert.ok(check > 0, 'hooks.server never runs the mail check');
	assert.ok(check < hooks.indexOf('void ensureSchema();'));
	assert.match(
		hooks.slice(check),
		/^assertMailConfig\(\);\n\} catch \(e\) \{\n\tlog\.error\('boot\.mail-refused', \{ error: e as Error \}\);\n\tthrow e;/
	);
});

// ---------------------------------------------------------------------------
// 3: long copy and placeholders
// ---------------------------------------------------------------------------

test('E41 R3: the landing hero, its band, the sidebar text and the edit-form helper are skin Markdown', async () => {
	assert.match(skinCopy('landing-hero'), /^<h1>Welcome to Example Community<\/h1>/);
	assert.match(skinCopy('landing-band'), /^<h2>/);
	assert.match(skinCopy('sidebar'), /Example Community/);
	assert.equal(
		skinCopy('affiliations-help'),
		'',
		'the default skin has no affiliations to explain'
	);

	const landing = await loader('src/routes/group/[slug]/+page.server.ts');
	const out = await landing(event('/'));
	assert.equal(out.heroHtml, skinCopy('landing-hero'));
	assert.equal(out.bandHtml, skinCopy('landing-band'));
	const home = await loader('src/routes/group/[slug]/home/+page.server.ts');
	assert.equal(
		(await home(event('/home', { email: 'a@example.org' }))).heroHtml,
		skinCopy('landing-hero')
	);
});

test('E41 R3: the components carry no community copy, and the member count is gone rather than moved', () => {
	const landing = read('src/lib/components/Landing.svelte');
	assert.match(landing, /\{@html heroHtml\}/);
	assert.match(landing, /\{@html bandHtml\}/);
	assert.doesNotMatch(landing, /Moz|alumni|\d+\+/);
	const sidebar = read('src/lib/components/Sidebar.svelte');
	assert.match(sidebar, /\{@html blurbHtml\}/);
	assert.doesNotMatch(sidebar, /Moz|co-created/);
	const edit = read('src/routes/group/[slug]/members/[id]/edit/+page.svelte');
	assert.match(edit, /\{@html data\.affiliations\.helpHtml\}/);
	assert.doesNotMatch(edit, /Moz/);
	assert.match(
		read('src/routes/group/[slug]/members/[id]/edit/+page.server.ts'),
		/helpHtml: skinCopy\('affiliations-help'\)/
	);
});

test('E41 R3: the request form\'s "Other" hint is the affiliationOther field\'s placeholder', () => {
	const page = read('src/routes/group/[slug]/request/+page.svelte');
	assert.match(page, /placeholder=\{data\.otherPlaceholder\}/);
	assert.doesNotMatch(page, /Hive Network/);
	assert.match(
		read('src/routes/group/[slug]/request/+page.server.ts'),
		/otherPlaceholder: optionalFieldByRole\('affiliationOther'\)\?\.placeholder \?\? ''/
	);
	// The nickname examples live with their field in the skin, never in code.
	assert.doesNotMatch(read('src/lib/server/member-edit.ts'), /placeholder: '/);
});

// ---------------------------------------------------------------------------
// 4: the two documents
// ---------------------------------------------------------------------------

test('E41 R4: a skin without a document gets a 404 for its route and no link to it', async () => {
	for (const [route, name] of [
		['manifesto', 'manifesto'],
		['code-of-conduct', 'code-of-conduct']
	] as const) {
		assert.equal(hasSkinCopy(name), false, `the default skin ships ${name}`);
		const load = await loader(`src/routes/group/[slug]/${route}/+page.server.ts`);
		await assert.rejects(load(event(`/${route}`)), (e: { status?: number }) => e.status === 404);
	}
	const layout = await loader('src/routes/group/[slug]/+layout.server.ts');
	const data = await layout(
		event('/members', { email: 'a@example.org', subject: 'email:a@example.org' })
	);
	assert.deepEqual(data.documents, { manifesto: false, codeOfConduct: false, privacy: false });

	for (const f of ['src/lib/components/Landing.svelte', 'src/lib/components/Sidebar.svelte']) {
		const src = read(f);
		assert.match(
			src,
			/\{#if documents\.manifesto\}\s*<(li|a)[\s\S]*?\/manifesto/,
			`${f} links the manifesto unconditionally`
		);
		assert.match(src, /\{#if documents\.codeOfConduct\}\s*<(li|a)[\s\S]*?\/code-of-conduct/, f);
	}
	for (const name of ['landing', 'layout']) {
		const page = read(
			name === 'landing'
				? 'src/routes/group/[slug]/+page.svelte'
				: 'src/routes/group/[slug]/+layout.svelte'
		);
		assert.match(page, /documents=\{data\.documents\}/, name);
	}
});

test('E41 R4: the document pages render skin Markdown, and no page links a Google Doc', () => {
	for (const route of ['manifesto', 'code-of-conduct']) {
		assert.doesNotMatch(read(`src/routes/group/[slug]/${route}/+page.svelte`), /docs\.google\.com/);
		assert.match(
			read(`src/routes/group/[slug]/${route}/+page.server.ts`),
			new RegExp(`skinCopy\\('${route}'\\)`)
		);
	}
	const groups = read('src/lib/server/groups.ts');
	assert.doesNotMatch(
		groups,
		/manifesto|conduct/i,
		'the group reader still selects the dropped columns'
	);
});

// ---------------------------------------------------------------------------
// 5: analytics
// ---------------------------------------------------------------------------

test('E41 R5: the default skin sets no analytics, so the page has no tag and the policy no origin', async () => {
	assert.equal(analytics, undefined, 'the default skin turns analytics on');
	const { default: config } = await import('../../../svelte.config.js');
	assert.doesNotMatch(JSON.stringify(config.kit?.csp), /usefathom/);

	const layout = read('src/routes/+layout.svelte');
	assert.doesNotMatch(layout, /usefathom|ITYUHQCY/);
	assert.match(layout, /\{#if tracker\}\s*<script \{\.\.\.tracker\} defer><\/script>\s*\{\/if\}/);
	assert.doesNotMatch(read('svelte.config.js'), /'https:\/\/cdn\.usefathom\.com'/);
});

// ---------------------------------------------------------------------------
// 6: tests, fixtures and scripts
// ---------------------------------------------------------------------------

// Spelled in parts so the sweep in requirement 7 does not count this file.
const MOZ = ['moz', 'alums'].join('');
const PRIOR = new RegExp(
	`${MOZ}\\.com|${['Mozi', 'lla'].join('')} Alumni|mail\\.cow\\.org|${['Ma', 'tt Man', 'kins'].join('')}|${['semi', 'colons'].join('')}\\.com`,
	'i'
);

test("E41 R6: application tests and their fixtures use example.org and the default skin's names", () => {
	const tracked = execFileSync('git', ['ls-files', 'src', 'scripts'], {
		cwd: ROOT,
		encoding: 'utf8'
	})
		.split('\n')
		.filter((f) => /\.test\.(ts|mjs)$|fixture/.test(f));
	const hits = tracked.filter((f) => PRIOR.test(read(f)));
	assert.deepEqual(hits, []);
	const a11y = read('src/lib/a11y.test.ts');
	assert.match(a11y, /currentSkin\(\)\.skin/);
	assert.doesNotMatch(a11y, new RegExp(MOZ, 'i'));
});

test("E41 R6: the seed creates the skin's default group with invented members only", () => {
	const seed = read('scripts/seed.ts');
	assert.doesNotMatch(seed, PRIOR);
	assert.doesNotMatch(seed, new RegExp(MOZ, 'i'));
	for (const [, address] of seed.matchAll(/email: '([^']+)'/g)) {
		assert.match(address, /@example\.org$/);
	}
	assert.match(seed, /const \{ site \} = currentSkin\(\)\.skin;/);
	assert.match(seed, /\[site\.default_group, site\.name, landingMd\]/);
	const scripts = execFileSync('git', ['ls-files', 'scripts'], { cwd: ROOT, encoding: 'utf8' })
		.split('\n')
		.filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
	for (const f of scripts) {
		assert.doesNotMatch(read(f), new RegExp(`'${MOZ}'`), `${f} defaults to a community's slug`);
	}
});

// ---------------------------------------------------------------------------
// 8: the reference page
// ---------------------------------------------------------------------------

test('E41 R8: docs/skin.md describes every copy file, the mail block and the analytics block', () => {
	const doc = read('docs/skin.md');
	for (const name of COPY_NAMES) assert.match(doc, new RegExp(`\\| \`${name}\\.md\`\\s*\\|`), name);
	for (const heading of ['## Mail', '## Analytics', '## Copy'])
		assert.ok(doc.includes(`\n${heading}\n`), heading);
	for (const key of [
		'site.name',
		'site.default_group',
		'from_name',
		'sign_in_subject',
		'signature',
		'credit',
		'provider'
	]) {
		assert.ok(doc.includes(`\`${key}\``), key);
	}
});

// ---------------------------------------------------------------------------
// E42: what the messages show is the skin's logo and accent
// ---------------------------------------------------------------------------

test("E42 R2, R3: every message's logo, its alt text and its button colors are the skin's", async () => {
	const { brand } = currentSkin().skin;
	const { light } = currentSkin().theme;
	// The object the mail modules read, which an earlier test's restore of
	// process.env leaves detached from process.env itself.
	const { env } = await import('$env/dynamic/private');
	const settings: Record<string, string> = {
		MAIL_TRANSPORT: 'mailgun',
		MAIL_DOMAIN: 'mg.example.org',
		MAILGUN_PRIVATE: 'test-no-network',
		NOTIFY_ADMIN_ADDRESS: 'admin@example.org'
	};
	const saved = Object.fromEntries(Object.keys(settings).map((k) => [k, env[k]]));
	Object.assign(env, settings);
	try {
		mailgunSent.length = 0;
		const email = await import('../server/email');
		await email.sendMagicLinkEmail({ toEmail: 'a@example.org', url: 'https://x/auth/magic?t=1' });
		await email.sendMembershipApprovedEmail({
			to: 'a@example.org',
			groupName: 'Chess Club',
			signInUrl: 'https://x/login'
		});
		await email.sendMembershipRequestNotice({
			groupName: 'Chess Club',
			requesterEmail: 'a@example.org',
			rows: [],
			reviewUrl: 'https://x/admin/requests'
		});
		const [signIn, approved, notice] = mailgunSent.map((m) => String(m.html));
		const logo = `src="https://www.${site.domain}/${brand.email_logo}" alt="${site.name}"`;
		assert.ok(signIn.includes(logo), 'the sign-in message logo');
		assert.ok(approved.includes(logo), 'the approval message logo');
		assert.ok(signIn.includes(`background-color: ${light.accent};`));
		assert.ok(signIn.includes(`color: ${light.accentContrast}; text-decoration: none`));
		assert.ok(signIn.includes(`style="color: ${light.accent}">${mail.signature}</a>`));
		for (const html of [approved, notice]) {
			assert.ok(html.includes(`background:${light.accent};color:${light.accentContrast};`));
		}
		assert.notEqual(light.accent, '#000000', 'the default skin cannot pass on the old black');
		for (const html of [signIn, approved, notice]) {
			assert.doesNotMatch(html, /background(?:-color)?: ?#000\b/);
		}
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete env[k];
			else env[k] = v;
		}
	}
});
