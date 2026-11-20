import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock, test } from 'node:test';
const source = (path) => pathToFileURL(resolve(path)).href;
const { currentSkin } = await import(source('src/lib/skin/load.ts'));
process.env.MAIL_TRANSPORT = 'mailgun';
process.env.MAIL_DOMAIN = 'mg.example.org';
process.env.MAILGUN_PRIVATE = 'test-no-network';
register('data:text/javascript,' + encodeURIComponent(`
const source = 'export const env = process.env;';
export async function resolve(specifier, context, next) {
  if (specifier === '$env/dynamic/private' || specifier === '$env/dynamic/public')
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  return next(specifier, context);
}`), import.meta.url);
const sent = [];
mock.module('mailgun.js', { defaultExport: class {
  client() { return { messages: { create: async (domain, message) => { sent.push(message); } } }; }
} });
const { sendMagicLinkEmail, sendMembershipApprovedEmail } = await import(source('src/lib/server/email.ts'));
const { mail } = currentSkin().skin;
test('R2: Mailgun carries the skin display name in From for both identity messages', async () => {
  await sendMagicLinkEmail({ toEmail: 'member@example.org', url: 'https://www.example.org/auth/magic?token=test' });
  await sendMembershipApprovedEmail({ to: 'member@example.org', groupName: 'Example Community', signInUrl: 'https://www.example.org/login' });
  assert.equal(sent.length, 2);
  console.log(JSON.stringify(sent.map(({from, 'h:Sender': sender}) => ({from, sender}))));
  for (const message of sent) assert.ok(message.from.includes(mail.from_name), 'From omits mail.from_name: ' + message.from);
});

test('R2: the raw mail template carries no borrowed site origin', async () => {
  const { MAGIC_LINK_EMAIL_HTML } = await import(source('src/lib/server/magic-link-template.ts'));
  assert.deepEqual(MAGIC_LINK_EMAIL_HTML.match(/https?:\/\/www\.(?:lorem\.host|ident\.agency)\b/g) ?? [], []);
});
