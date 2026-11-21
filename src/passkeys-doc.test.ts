import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The passkey reference sections are held to the code they describe: the
// numbers they quote are read from the constants, and every log event the code
// emits must be named, so a change on either side that the other misses fails.

const ROOT = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

function section(page: string, heading: string): string {
	const level = heading.match(/^#+/)![0];
	const start = page.split('\n').findIndex((line) => line === heading);
	assert.ok(start >= 0, `no "${heading}" heading`);
	const lines = page.split('\n').slice(start + 1);
	const end = lines.findIndex((line) => new RegExp(`^#{1,${level.length}} `).test(line));
	return lines.slice(0, end < 0 ? undefined : end).join('\n');
}

function constant(file: string, name: string): number {
	const m = read(file).match(new RegExp(`const ${name} = ([0-9 *]+);`));
	assert.ok(m, `${name} is no longer a literal in ${file}`);
	return m[1].split('*').reduce((n, f) => n * Number(f.trim()), 1);
}

function emittedEvents(): string[] {
	const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
		.split('\n')
		.filter((f) => /\.(ts|svelte)$/.test(f) && !/\.test\./.test(f));
	const events = new Set<string>();
	for (const file of files) {
		for (const m of read(file).matchAll(/'(auth\.passkey\.[a-z-]+)'/g)) events.add(m[1]);
	}
	return [...events];
}

test('F8 R6: docs/features.md has a Passkeys section that matches the code', () => {
	const doc = section(read('docs/features.md'), '## Passkeys');

	const fresh = constant('src/lib/server/passkeys.ts', 'FRESH_SESSION_MS') / 60_000;
	assert.match(doc, new RegExp(`\\*\\*${fresh} minutes\\*\\*`), 'registration freshness');
	const ttl = constant('src/lib/server/passkey-store.ts', 'CHALLENGE_TTL') / 60;
	assert.match(doc, new RegExp(`\\*\\*${ttl} minutes\\*\\*`), 'challenge lifetime');
	const cap = constant('src/routes/(auth)/auth/passkey/+server.ts', 'OPTIONS_MAX');
	assert.match(doc, new RegExp(`capped separately at ${cap} per IP`), 'sign-in options cap');
	const nick = constant('src/lib/server/passkey-store.ts', 'NICKNAME_MAX');
	assert.match(doc, new RegExp(`up to ${nick} characters`), 'nickname length');

	const store = read('src/lib/server/passkey-store.ts');
	for (const option of ["residentKey: 'required'", "userVerification: 'preferred'"]) {
		assert.ok(store.includes(option), `the store no longer sets ${option}`);
		assert.ok(doc.includes(`\`${option}\``), `the section does not state ${option}`);
	}

	const events = emittedEvents();
	assert.ok(events.length >= 8, `found only ${events.length} passkey log events`);
	const missing = events.filter((name) => !doc.includes(`\`${name}\``));
	assert.deepEqual(missing, [], 'emitted by the code, not named in the Passkeys section');

	for (const fact of [
		'`passkey_credential`',
		'ON DELETE CASCADE',
		'mintEmailSession',
		'`magic-rl:ip`'
	]) {
		assert.ok(doc.includes(fact), `the section no longer mentions ${fact}`);
	}
	assert.match(doc, /\[`auth\.passkeys: false`\]\(skin\.md#sign-in\)/);
});

test('F8 R6: docs/configuration.md documents the auth.passkeys skin key', () => {
	const doc = section(read('docs/configuration.md'), '### Passkeys (`auth.passkeys`)');

	assert.match(doc, /a boolean that defaults to `true`/);
	assert.match(doc, /```yaml\nauth:\n {2}passkeys: false\n```/);
	for (const [route, file] of [
		['/auth/passkey', 'src/routes/(auth)/auth/passkey/+server.ts'],
		['/members/<id>/passkeys', 'src/routes/group/[slug]/members/[id]/passkeys/+server.ts']
	]) {
		assert.ok(existsSync(new URL(file, ROOT)), `${file} is gone`);
		assert.ok(doc.includes(`\`${route}\``), `the section does not name ${route}`);
	}
	for (const name of ['PUBLIC_BASE_DOMAIN', 'ORIGIN']) {
		assert.ok(doc.includes(`\`${name}\``), `the section does not name ${name}`);
	}
	assert.match(doc, /Moving the apex orphans every passkey/);
	assert.match(doc, /\(features\.md#passkeys\)/);
	assert.match(read('docs/features.md'), /\(configuration\.md#passkeys-authpasskeys\)/);
});
