// Connection settings for both Postgres clients in this repo: the app pool
// (`postgres.ts`) and the operator CLI pool (`scripts/db.ts`). They share this
// module rather than each carrying a copy of the same defaults, because a TLS
// posture that holds in one of the two is not a posture.
//
// The rule it exists to enforce: TLS on means the certificate is verified.
// `POSTGRES_SSL=true` gets typed by someone who has just pointed POSTGRES_HOST
// at a database across a network — the one setting where a silent downgrade
// costs the whole member directory, and the one place an operator is entitled to
// assume the flag means what its name says. So verification is not optional
// under that flag: a managed provider with a private CA supplies the CA
// (POSTGRES_SSL_CA), and anyone who genuinely wants an unauthenticated tunnel
// requests it under a name that says so (POSTGRES_SSL_INSECURE).

import { readFileSync } from 'node:fs';
import { log } from './log';

type EnvSource = Record<string, string | undefined>;

export type PostgresSsl = false | { ca?: string; rejectUnauthorized: boolean };

export type PostgresConnection = {
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl: PostgresSsl;
};

// An unrecognised value used to read as `false`, so `POSTGRES_SSL=1` turned TLS
// off and said nothing. Refusing it costs a restart; accepting it costs the
// directory.
function flag(name: string, raw: string | undefined): boolean {
	const value = (raw ?? '').trim().toLowerCase();
	if (value === '' || value === 'false') return false;
	if (value === 'true') return true;
	throw new Error(
		`${name}=${JSON.stringify(raw)} is not a boolean. Set it to "true" or "false" — any other value would read as false and turn TLS off without a word.`
	);
}

// Inline PEM or a path to one. A `\n`-escaped PEM is accepted, so a
// single-line `.env` carries either.
function loadCa(value: string): string {
	const pem = value.replace(/\\n/g, '\n');
	if (pem.startsWith('-----BEGIN')) return pem;
	try {
		return readFileSync(value, 'utf8');
	} catch (e) {
		throw new Error(
			`POSTGRES_SSL_CA names ${JSON.stringify(value)}, which could not be read: ${(e as Error).message}. Give a path the process can open (mount it into the container), or paste the PEM itself with \\n between lines.`
		);
	}
}

function resolveSsl(env: EnvSource): PostgresSsl {
	const on = flag('POSTGRES_SSL', env.POSTGRES_SSL);
	const insecure = flag('POSTGRES_SSL_INSECURE', env.POSTGRES_SSL_INSECURE);
	const ca = env.POSTGRES_SSL_CA?.trim();

	if (!on) {
		// Refused rather than ignored: whoever set the insecure flag believes
		// there is a TLS session to relax, and there is no session at all.
		if (insecure) {
			throw new Error(
				'POSTGRES_SSL_INSECURE=true while POSTGRES_SSL is off: this connection is plaintext, not unverified TLS. Set POSTGRES_SSL=true, or clear POSTGRES_SSL_INSECURE.'
			);
		}
		if (ca) {
			log.warn('postgres.ssl-ca-unused', {
				hint: 'POSTGRES_SSL_CA is set but POSTGRES_SSL is off, so the connection carries no TLS at all'
			});
		}
		// `false`, never `undefined`: pg falls back to reading PGSSLMODE from the
		// process environment when `ssl` is undefined, and `PGSSLMODE=no-verify`
		// there would reinstate the exact unverified TLS this module refuses to
		// configure (node_modules/pg/lib/connection-parameters.js:85).
		return false;
	}

	if (insecure) {
		log.warn('postgres.ssl-insecure', {
			host: env.POSTGRES_HOST ?? '127.0.0.1',
			caIgnored: Boolean(ca),
			hint: 'POSTGRES_SSL_INSECURE=true — the server certificate is not checked, so this connection is encrypted but not authenticated and anyone in the path can read it. Diagnosis only; supply POSTGRES_SSL_CA to run.'
		});
		return { rejectUnauthorized: false };
	}

	return ca ? { ca: loadCa(ca), rejectUnauthorized: true } : { rejectUnauthorized: true };
}

/**
 * Build the connection half of a `pg` pool config from an env source. Callers
 * add their own pool sizing; nobody gets to add their own TLS posture.
 */
export function postgresConnection(env: EnvSource): PostgresConnection {
	return {
		host: env.POSTGRES_HOST ?? '127.0.0.1',
		port: Number(env.POSTGRES_PORT ?? 5433),
		database: env.POSTGRES_DATABASE ?? 'lorem',
		user: env.POSTGRES_USER ?? 'lorem',
		password: env.POSTGRES_PASSWORD ?? '',
		ssl: resolveSsl(env)
	};
}
