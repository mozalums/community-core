// Explicit migration runner for CI / deploy. Exits non-zero on failure so a
// deploy step can gate on it. Usage: pnpm migrate
import { migrateGated, MIGRATIONS } from '../src/lib/server/migrations';
import { scriptPool } from './db';

const pool = scriptPool();

migrateGated(pool, process.env.LOREM_WRITERS_STOPPED, (line) => console.log(line))
	.then(async (applied) => {
		if (applied.length > 0) {
			console.log(`migrated: applied ${applied.join(', ')}`);
		} else {
			console.log('migrated: already up to date');
		}
		const { rows } = await pool.query<{ version: number; name: string }>(
			'SELECT version, name FROM schema_migrations ORDER BY version'
		);
		console.log(`schema at: ${rows.map((r) => `${r.version}:${r.name}`).join(', ')}`);
		if (rows.length !== MIGRATIONS.length) {
			throw new Error(
				`ledger has ${rows.length} rows but ${MIGRATIONS.length} migrations are defined`
			);
		}
		await pool.end();
		process.exit(0);
	})
	.catch(async (e) => {
		console.error('[migrate] failed:', e);
		await pool.end().catch(() => {});
		process.exit(1);
	});
