// Operator escape hatch for audit retention: the same pruneAudit the app runs
// on its own timer, for a host that wants a prune now or keeps the app stopped.
// Usage: pnpm prune-audit, or on the host the `prune` compose profile.
import { parseAuditConfig, pruneAudit } from '../src/lib/server/audit-core';
import { scriptPool } from './db';

const pool = scriptPool();

async function main() {
	const cfg = parseAuditConfig(process.env);
	const r = await pruneAudit(pool, cfg);
	if (r.skipped) {
		console.log('prune-audit: another process holds the prune lock; nothing done');
	} else {
		console.log(
			`prune-audit: deleted ${r.deleted} row(s) in ${r.batches} batch(es) ` +
				`(retention ${cfg.retentionDays || 'forever'}d, authz ${cfg.retentionDaysAuthz || 'forever'}d)`
		);
	}
}

main()
	.then(async () => {
		await pool.end();
		process.exit(0);
	})
	.catch(async (e) => {
		console.error('[prune-audit] failed:', e);
		await pool.end().catch(() => {});
		process.exit(1);
	});
