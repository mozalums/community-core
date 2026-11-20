import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = process.env.E44_REVIEW_ROOT || process.cwd();
const deployment = readFileSync(resolve(root, 'docs/deployment.md'), 'utf8');

test('R2: first install puts image SKIN_DIR in the deployment secrets .env', () => {
  const secrets = deployment.split('**4. The secrets files**')[1]?.split('**5. DNS**')[0];
  assert.ok(secrets, 'first-install secrets instructions are missing');
  assert.match(secrets, /SKIN_DIR/, 'the secrets-file instructions must set SKIN_DIR');
  assert.doesNotMatch(deployment, /`SKIN_DIR` belongs here as well/, 'deploy.env must not remain the prescribed home of image SKIN_DIR');
});
