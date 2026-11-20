import pg from 'pg';
import { env } from '$env/dynamic/private';
import { log } from './log';
import { postgresConnection } from './postgres-config';

const { Pool } = pg;

let cached: pg.Pool | null = null;

function pool(): pg.Pool {
	if (cached) return cached;
	cached = new Pool({
		...postgresConnection(env),
		max: 5,
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000
	});
	cached.on('error', (err) => log.error('postgres.pool-error', { error: err as Error }));
	return cached;
}

// The shared connection pool. Exposed for the migration engine, which needs
// a dedicated client off the pool for the session-scoped advisory lock.
export function pgPool(): pg.Pool {
	return pool();
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
	text: string,
	params?: unknown[]
): Promise<pg.QueryResult<T>> {
	return pool().query<T>(text, params as never[]);
}

// Run multiple statements on a single checked-out connection inside a
// BEGIN/COMMIT (or ROLLBACK on throw). Use this when you need transactional
// semantics — `query()` alone won't suffice because each call may pick a
// different pool connection.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
	const client = await pool().connect();
	try {
		await client.query('BEGIN');
		const result = await fn(client);
		await client.query('COMMIT');
		return result;
	} catch (e) {
		try {
			await client.query('ROLLBACK');
		} catch {
			// best-effort
		}
		throw e;
	} finally {
		client.release();
	}
}

export async function closePool(): Promise<void> {
	if (cached) {
		await cached.end();
		cached = null;
	}
}
