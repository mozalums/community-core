import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mock, test } from 'node:test';
import { currentSkin } from '../skin/load';

// A deployment served from a host that is not www. plus its apex, as dev is:
// every address its mail gives for the site is ORIGIN, never www.<host>, which
// does not resolve.

process.env.ORIGIN = 'https://dev.example.org';
process.env.PUBLIC_BASE_DOMAIN = 'dev.example.org';
process.env.NOTIFY_ADMIN_ADDRESS = 'admin@example.org';

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
  }`)
);

type Sent = { subject: string; html: string; text: string };
const sent: Sent[] = [];
mock.module('$lib/server/mail', {
	namedExports: { sendMail: async (m: Sent) => void sent.push(m), mailConfigured: () => true }
});
mock.module('$lib/server/postgres', { namedExports: { query: async () => ({ rows: [] }) } });
mock.module('$lib/server/redis', { namedExports: { redis: {} } });

const email = await import('./email');
const { relyingParty } = await import('./passkey-store');
const { APP_BASE_URL, siteUrl } = await import('../site');
const { brand } = currentSkin().skin;

async function render(): Promise<Sent[]> {
	sent.length = 0;
	await email.sendMagicLinkEmail({
		toEmail: 'a@example.org',
		url: 'https://dev.example.org/auth/magic?token=t'
	});
	await email.sendMembershipApprovedEmail({
		to: 'a@example.org',
		groupName: 'Chess Club',
		signInUrl: 'https://dev.example.org/login'
	});
	await email.sendMembershipRequestNotice({
		groupName: 'Chess Club',
		requesterEmail: 'a@example.org',
		rows: [{ label: 'Name', value: 'Ada' }],
		reviewUrl: 'https://dev.example.org/group/x/admin/requests'
	});
	return [...sent];
}

const urls = (s: string) => s.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];

test('E54 R1, R3: every site address in the mail is ORIGIN', async () => {
	const mails = await render();
	assert.equal(mails.length, 3);
	const [signIn, approved] = mails;
	const logo = `src="https://dev.example.org/${brand.email_logo}"`;
	assert.ok(signIn.html.includes(logo), 'the sign-in logo');
	assert.ok(approved.html.includes(logo), 'the approval logo');
	assert.ok(signIn.html.includes('href="https://dev.example.org/?utm_source=login"'), 'header');
	assert.ok(signIn.html.includes('<a href="https://dev.example.org/" style='), 'signature');
	for (const [i, m] of mails.entries()) {
		const found = urls(m.html + '\n' + m.text);
		for (const u of found) {
			assert.doesNotMatch(u, /www\.dev/, `mail ${i}: ${u}`);
			if (/^https?:\/\/[^/]*example\.org/.test(u))
				assert.ok(u.startsWith('https://dev.example.org/'), `mail ${i}: ${u}`);
		}
	}
});

test('E54 R1: a trailing slash on ORIGIN is trimmed, not doubled', async (t) => {
	process.env.ORIGIN = 'https://dev.example.org/';
	t.after(() => (process.env.ORIGIN = 'https://dev.example.org'));
	const [signIn] = await render();
	assert.ok(signIn.html.includes(`src="https://dev.example.org/${brand.email_logo}"`));
	assert.doesNotMatch(signIn.html, /dev\.example\.org\/\//);
});

test('E54 R3: with ORIGIN unset, mail falls back to www. plus the apex', async (t) => {
	assert.equal(siteUrl(undefined), APP_BASE_URL);
	assert.equal(siteUrl(''), 'https://www.dev.example.org');
	assert.equal(siteUrl('https://dev.example.org/'), 'https://dev.example.org');
	delete process.env.ORIGIN;
	t.after(() => (process.env.ORIGIN = 'https://dev.example.org'));
	const [signIn] = await render();
	assert.ok(signIn.html.includes(`src="https://www.dev.example.org/${brand.email_logo}"`));
});

test('E54 R2: passkeys accept ORIGIN and no longer www.<host>', (t) => {
	assert.deepEqual(relyingParty(), {
		rpID: 'dev.example.org',
		origins: ['https://dev.example.org']
	});
	delete process.env.ORIGIN;
	t.after(() => (process.env.ORIGIN = 'https://dev.example.org'));
	assert.deepEqual(relyingParty().origins, ['https://www.dev.example.org']);
});
