import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

test('published approval emails keep their original logo URL', () => {
  const name = ['moz', 'alums'].join('');
  const path = `skin/${name}/static/email/shared/${name}-logo.png`;
  assert.ok(existsSync(path), `published email asset disappeared: ${path}`);
  assert.deepEqual([...readFileSync(path).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
