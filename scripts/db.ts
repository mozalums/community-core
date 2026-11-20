// Script-only Postgres pool. Passes process.env (tsx is invoked with
// --env-file=.env) so CLI scripts don't pull in SvelteKit's $env virtual
// module the way src/lib/server/postgres.ts does. Everything below the pool
// size comes from postgres-config, so a migration run reaches the database
// under the same TLS posture the app does.
import pg from 'pg';
import { postgresConnection } from '../src/lib/server/postgres-config';

const { Pool } = pg;

export function scriptPool(): pg.Pool {
	return new Pool({
		...postgresConnection(process.env),
		max: 4,
		connectionTimeoutMillis: 5_000
	});
}
