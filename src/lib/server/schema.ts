import { pgPool } from '$lib/server/postgres';
import { migrate } from '$lib/server/migrations';
import { log } from '$lib/server/log';

let ran = false;

// Idempotent boot-time schema bootstrap. Delegates to the pure migration
// engine (migrations.ts), which is advisory-locked + transactional. The
// process-local `ran` guard makes the common already-migrated path a no-op.
// Errors are swallowed so a transient DB hiccup at boot doesn't crash the
// server. Nothing retries them: the only call site is module load in
// hooks.server.ts, so a failure here is caught by the `pnpm migrate` deploy
// step, which exits non-zero, and not by this.
export async function ensureSchema(): Promise<void> {
	if (ran) return;
	try {
		const applied = await migrate(pgPool(), (line) => log.info('schema.migrate.note', { line }));
		if (applied.length > 0) {
			log.info('schema.migrate.applied', { versions: applied });
		} else {
			log.debug('schema.migrate.up-to-date', {});
		}
		ran = true;
	} catch (e) {
		log.error('schema.migrate.error', { error: e as Error });
	}
}
