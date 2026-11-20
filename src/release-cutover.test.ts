import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// From the eighth F3 review's probe. The migration instructions it reads moved
// from the old readme to docs/deployment.md.
test('R7: the migration-13 instructions never accept an unstopped CI window', () => {
  const readme = readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8');
  const release = readme.split('**Migration 13 needs the app stopped.**')[1]
    .split('**Rehearse it first.**')[0].replace(/\s+/g, ' ');
  assert.equal(release.includes('a merge that deploys through it accepts the window instead'),
    false, 'R7 requires stopping the app; the README still accepts migrating under old readers/writers');
});

test('R7: every documented migrate run against a pre-13 database stops the writers first', () => {
	const readme = readFileSync(new URL('../docs/deployment.md', import.meta.url), 'utf8');
	const release = readme
		.split('**Migration 13 needs the app stopped.**')[1]
		.split('**Rehearse it first.**')[0];
	const lines = release.split('\n');
	const stop = lines.findIndex((l) => /(?:docker compose|\bdc) stop lorem-host/.test(l));
	const run = lines.findIndex((l) => /--profile migrate run/.test(l));
	assert.ok(stop >= 0 && run > stop, 'the release sequence migrates before stopping the app');
	assert.match(lines[run], /LOREM_WRITERS_STOPPED=/);
	const prose = release.replace(/\s+/g, ' ');
	assert.match(prose, /required on every path/);
	assert.doesNotMatch(prose, /accepts? the window|if that window is not acceptable/);
	assert.match(prose, /CI deploy[\s\S]*?fails at the migrate step/);
});
