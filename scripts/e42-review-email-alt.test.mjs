import assert from 'node:assert/strict';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock, test } from 'node:test';

const file = (path) => pathToFileURL(resolve(path)).href;
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === '$env/dynamic/private' || specifier === '$env/dynamic/public')
    return { url: 'data:text/javascript,export const env = process.env;', shortCircuit: true };
  return next(specifier, context);
}`), import.meta.url);

const sent = [];
mock.module(file('src/lib/server/mail.ts'), {
  namedExports: { sendMail: async (message) => { sent.push(message); } }
});
const { site } = await import('$skin/skin.yaml');
const { sendMagicLinkEmail, sendMembershipApprovedEmail } = await import(file('src/lib/server/email.ts'));

test('R2: both email logo alt attributes preserve a display name containing quotes', async () => {
  const saved = site.name;
  try {
    site.name = 'Example "Community"';
    await sendMagicLinkEmail({ toEmail: 'member@example.org', url: 'https://www.example.org/auth/magic?t=1' });
    await sendMembershipApprovedEmail({ to: 'member@example.org', groupName: 'Chess', signInUrl: 'https://www.example.org/login' });
    for (const message of sent) {
      const image = message.html.match(/<img\b[^>]*>/)[0];
      console.log(message.tag, image);
      assert.match(image, /alt="Example &quot;Community&quot;"/, message.tag + ': display name escaped for an attribute');
    }
  } finally {
    site.name = saved;
  }
});
