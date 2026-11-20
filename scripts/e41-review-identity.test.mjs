import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('R6: ADMIN_SUBJECTS example uses an invented example.org identity', () => {
  const line = readFileSync('.env.example', 'utf8').split('\n').find(line => /^# Example: ADMIN_SUBJECTS=/.test(line));
  console.log(line);
  assert.match(line, /^# Example: ADMIN_SUBJECTS=email:[a-z0-9._+-]+@example\.org$/i);
});
test('R7: tracked platform files have zero community literals, without exemptions', () => {
  const words = [['moz','illa'],['moz','alum'],['moz','illian'],['mo','co'],['mo','fo'],['moz','reps'],['moz','fest']].map(parts => parts.join('')).join('|');
  const result = spawnSync('git', ['grep', '-c', '-i', '-E', words, '--', 'src', 'scripts', '.env.example'], { encoding: 'utf8' });
  console.log(result.stdout);
  assert.ifError(result.error);
  assert.equal(result.status, 1, 'git grep must find zero matching tracked files');
  assert.equal(result.stdout, '');
});
