import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
const root = process.env.E43_REVIEW_ROOT || process.cwd();
const page = readFileSync(join(root, 'docs/deployment.md'), 'utf8');
const move = page.split('## Moving hosts\n')[1];

// A stopped container is not a writer fence while a deploy can run compose up.
// Match the operational action, without requiring one particular mechanism.
const blocksDeploys = /(?:disable|suspend|block|prevent|remove|revoke|stop)[^.\n]*(?:CI|deploy|automation|key)|(?:CI|deploy|automation)[^.\n]*(?:disabled|suspended|blocked|prevented)/i;
const drainsDeploys = /(?:wait|drain|finish|complete|terminate|cancel)[^.\n]*(?:in.flight|in.progress|running|active|already.started)[^.\n]*(?:deploy|job|session)|(?:in.flight|in.progress|running|active|already.started)[^.\n]*(?:deploy|job|session)[^.\n]*(?:wait|drain|finish|complete|terminate|cancel)/i;

test('R2: the forward freeze drains deploys already admitted before stopping the writer', () => {
  const beforeStop = move.slice(0, move.indexOf('docker compose stop lorem-host'));
  assert.match(beforeStop, blocksDeploys);
  assert.match(beforeStop, drainsDeploys,
    'Removing an authorized key or changing DEPLOY_HOST does not stop an SSH deploy already running; its later compose up can undo the freeze.');
});

test('R2: rollback fences and drains deploy automation on the new writer before stopping it', () => {
  const rollback = move.split('**Rolling back**')[1];
  const activeBranch = rollback.split('- **The new app was started, even once.**')[1];
  assert.ok(activeBranch, 'Keep the rollback case for a new host that accepted writes.');
  const stop = activeBranch.indexOf('sudo docker compose --env-file deploy/deploy.env stop lorem-host');
  assert.ok(stop >= 0, 'Rollback must stop the current writer.');
  const beforeStop = rollback.split('\n- **')[0] + activeBranch.slice(0, stop);
  assert.match(beforeStop, blocksDeploys,
    'The documented move can point DEPLOY_HOST at the new host; rollback leaves that CI target enabled while taking its final dump.');
  assert.match(beforeStop, drainsDeploys,
    'Any deploy already running on the new host must finish or be terminated before its writer is stopped.');
});
