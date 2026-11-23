import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import { mock, test } from 'node:test';

// A deployment whose public address is www. plus its apex, as production is.
// Its mail must not change by a byte when mail starts following ORIGIN, so the
// digest below is of what the three messages rendered before it did.

process.env.ORIGIN = 'https://www.example.org';
delete process.env.PUBLIC_BASE_DOMAIN;

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

test('E54 R3: with ORIGIN at www. plus the apex, the mail is what it was', async () => {
	process.env.NOTIFY_ADMIN_ADDRESS = 'admin@example.org';
	sent.length = 0;
	await email.sendMagicLinkEmail({
		toEmail: 'a@example.org',
		url: 'https://www.example.org/auth/magic?token=t'
	});
	await email.sendMembershipApprovedEmail({
		to: 'a@example.org',
		groupName: 'Chess Club',
		signInUrl: 'https://www.example.org/login'
	});
	await email.sendMembershipRequestNotice({
		groupName: 'Chess Club',
		requesterEmail: 'a@example.org',
		rows: [{ label: 'Name', value: 'Ada' }],
		reviewUrl: 'https://www.example.org/group/x/admin/requests'
	});
	const rendered = JSON.stringify(sent.map(({ subject, html, text }) => ({ subject, html, text })));
	assert.equal(createHash('sha256').update(rendered).digest('hex'), '3256898d36822244c9804844fab3b31e2cb68955622713492c86e0e4dab0d0da');
});

test('E54 R2: a www. deployment accepts passkeys from its one origin', () => {
	assert.deepEqual(relyingParty(), {
		rpID: 'example.org',
		origins: ['https://www.example.org']
	});
});
