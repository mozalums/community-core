import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const args = ['--import', 'tsx', '--test', 'src/configuration-doc.test.ts'];
const run = (preload) => spawnSync(process.execPath,
  preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, ...args] : args,
  { cwd: process.cwd(), encoding: 'utf8', env: childEnv });

const mutations = {
  row: (page) => page.replace(/^\| `PUBLIC_BASE_DOMAIN`[^\n]*$/m,
    "| `PUBLIC_BASE_DOMAIN` | domain | the skin's `site.domain` | The session cookie, the canonical `www` URL and the mail sender follow the skin's domain, which is wrong on any other host. |"),
  hostname: (page) => page.replace(
    /(^## Hostname[^\n]*\n)[\s\S]*?(?=^### Passkeys)/m,
    '$1\nThe canonical www URL (`https://www.<apex>`) is used for the links and the logo in the sign-in email.\n\n')
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`E54 R4: documentation checks reject stale mail guidance in ${name}`, () => {
    const control = run();
    assert.equal(control.status, 0, control.stdout + control.stderr);
    const preload = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const original = fs.readFileSync;
      const mutate = ${mutate.toString()};
      fs.readFileSync = function(path, ...rest) {
        const result = original.call(this, path, ...rest);
        return String(path).endsWith('/docs/configuration.md') && typeof result === 'string'
          ? mutate(result) : result;
      };
      syncBuiltinESMExports();
    `;
    const stale = run(preload);
    assert.match(stale.stdout, /# tests [1-9]/, stale.stdout + stale.stderr);
    assert.match(stale.stdout, /# fail [1-9]/,
      `configuration tests accepted stale ${name} guidance (exit ${stale.status}):\n${stale.stdout}`);
  });
}
