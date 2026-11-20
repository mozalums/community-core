import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('R1: the test named in the requirement map actually executes', () => {
	const name = 'admin export: an outsider and a plain member get nothing';
	const r = spawnSync(process.execPath, [
		'--import', 'tsx', '--experimental-test-module-mocks', '--test', '--test-reporter=tap',
		`--test-name-pattern=^${name}$`,
		new URL('./route-guards.test.ts', import.meta.url).pathname
	], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
	assert.equal(r.status, 0, r.stderr);
	assert.ok(r.stdout.includes(`# Subtest: ${name}\n`), `R1's mapped test never ran:\n${r.stdout}`);
});
