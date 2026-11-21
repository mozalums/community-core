import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const compose = parse(readFileSync('docker-compose.yml', 'utf8'), { merge: true }) as {
	services: Record<string, { logging?: { driver?: string; options?: Record<string, string> } }>;
};

for (const name of ['lorem-host', 'postgres', 'redis']) {
	test(`${name} logs to journald under the community- tag the host's rsyslog rule drops`, () => {
		const logging = compose.services[name]?.logging;
		assert.equal(logging?.driver, 'journald');
		assert.match(logging?.options?.tag ?? '', /^community-/);
	});
}
