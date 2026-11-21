import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { Server } = await import(pathToFileURL(resolve('build/server/index.js')));
const { manifest } = await import(pathToFileURL(resolve('build/server/manifest.js')));
const gate = process.env.E53_REVIEW_GATE === 'password';
const server = new Server(manifest);
await server.init({ env: {
  SKIN_DIR: 'skin/mozalums',
  SITE_GATE: gate ? 'password' : 'off',
  SITE_GATE_PASSWORD: 'review-fixture-only',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: '1',
  POSTGRES_USER: 'e53_review', POSTGRES_PASSWORD: 'fixture', POSTGRES_DATABASE: 'e53_review',
  POSTGRES_SSL: 'false', REDIS_URL: 'redis://127.0.0.1:1', MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1'
} });
const names = ['community_cohort', 'community_utm'];
const path = gate ? '/' : '/members';

for (const held of [names, [names[0]], [names[1]], []]) {
  test(`E53 R2: ${gate ? 'gate page' : 'guest redirect'} expires ${held.join(', ') || 'no cookies'}`, async () => {
    const response = await server.respond(new Request(`https://review.example.org${path}`, {
      headers: held.length ? { cookie: held.map(name => `${name}=old`).join('; ') } : {}
    }), { getClientAddress: () => '127.0.0.1' });
    const actual = response.headers.getSetCookie().sort();
    console.log(JSON.stringify({ gate, path, held, status: response.status, location: response.headers.get('location'), setCookie: actual }));
    assert.equal(response.status, gate ? 200 : 303);
    assert.deepEqual(actual.map(line => line.slice(0, line.indexOf('='))).sort(), [...held].sort());
    for (const line of actual) {
      const [pair, ...flags] = line.split(';').map(part => part.trim());
      const attrs = Object.fromEntries(flags.map(flag => {
        const at = flag.indexOf('=');
        return at < 0 ? [flag.toLowerCase(), true] : [flag.slice(0, at).toLowerCase(), flag.slice(at + 1)];
      }));
      assert.equal(pair.slice(pair.indexOf('=') + 1), '');
      assert.equal(attrs.path, '/');
      assert.equal(attrs.samesite?.toLowerCase(), 'strict');
      assert.equal(attrs.secure, true);
      assert.equal(attrs.httponly, true);
      assert.equal(attrs.domain, undefined);
      assert.ok((attrs['max-age'] !== undefined && Number(attrs['max-age']) <= 0) || Date.parse(attrs.expires) < Date.now());
    }
  });
}
