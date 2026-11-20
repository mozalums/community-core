import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresConnection } from './postgres-config';

// A CA the pool config can carry verbatim. Nothing here opens a socket, so the
// bytes only have to be recognisable as a PEM.
const CA_PEM = '-----BEGIN CERTIFICATE-----\nMIIB9TCCAWACAQAwgb\n-----END CERTIFICATE-----\n';

// log.warn writes to console.error; a test that let it through would bury the
// real failures in the run, and the insecure case has to assert on it anyway.
function capture(fn: () => void): string {
	const lines: string[] = [];
	const sink = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
	const [origLog, origError] = [console.log, console.error];
	console.log = sink;
	console.error = sink;
	try {
		fn();
	} finally {
		console.log = origLog;
		console.error = origError;
	}
	return lines.join('\n');
}

test('SSL off: ssl is false, not undefined', () => {
	const { ssl } = postgresConnection({ POSTGRES_SSL: 'false' });
	// `undefined` would hand the decision to PGSSLMODE in the process
	// environment, where `no-verify` is a legal value.
	assert.equal(ssl, false);
	assert.equal(postgresConnection({}).ssl, false);
});

test('SSL on: the certificate is verified', () => {
	const { ssl } = postgresConnection({ POSTGRES_SSL: 'true' });
	assert.deepEqual(ssl, { rejectUnauthorized: true });
});

test('SSL on with a CA: verification stays on and the CA is carried', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lorem-ca-'));
	const path = join(dir, 'provider-ca.pem');
	writeFileSync(path, CA_PEM);

	const fromPath = postgresConnection({ POSTGRES_SSL: 'true', POSTGRES_SSL_CA: path }).ssl;
	assert.deepEqual(fromPath, { ca: CA_PEM, rejectUnauthorized: true });

	// The `\n`-escaped single-line form a .env file can hold.
	const fromEnv = postgresConnection({
		POSTGRES_SSL: 'true',
		POSTGRES_SSL_CA: CA_PEM.replace(/\n/g, '\\n')
	}).ssl;
	assert.deepEqual(fromEnv, { ca: CA_PEM, rejectUnauthorized: true });
});

test('the insecure opt-in is the only way to reach rejectUnauthorized: false, and it announces itself', () => {
	let ssl: unknown;
	const out = capture(() => {
		ssl = postgresConnection({
			POSTGRES_SSL: 'true',
			POSTGRES_SSL_INSECURE: 'true',
			POSTGRES_HOST: 'db.example.net'
		}).ssl;
	});
	assert.deepEqual(ssl, { rejectUnauthorized: false });
	assert.match(out, /"level":"warn"/);
	assert.match(out, /postgres\.ssl-insecure/);
	assert.match(out, /db\.example\.net/);
});

test('an unreadable CA path fails loudly rather than falling back to unverified', () => {
	assert.throws(
		() => postgresConnection({ POSTGRES_SSL: 'true', POSTGRES_SSL_CA: '/nonexistent/ca.pem' }),
		/POSTGRES_SSL_CA/
	);
});

test('a non-boolean POSTGRES_SSL is refused instead of reading as off', () => {
	assert.throws(() => postgresConnection({ POSTGRES_SSL: '1' }), /not a boolean/);
});

test('the insecure flag without TLS is refused: the connection is plaintext, not relaxed TLS', () => {
	assert.throws(
		() => postgresConnection({ POSTGRES_SSL_INSECURE: 'true' }),
		/POSTGRES_SSL_INSECURE=true while POSTGRES_SSL is off/
	);
});

test('the rest of the connection still comes through', () => {
	const conn = postgresConnection({
		POSTGRES_HOST: 'db.example.net',
		POSTGRES_PORT: '5432',
		POSTGRES_DATABASE: 'directory',
		POSTGRES_USER: 'app',
		POSTGRES_PASSWORD: 'hunter2',
		POSTGRES_SSL: 'true'
	});
	assert.deepEqual(conn, {
		host: 'db.example.net',
		port: 5432,
		database: 'directory',
		user: 'app',
		password: 'hunter2',
		ssl: { rejectUnauthorized: true }
	});
});
