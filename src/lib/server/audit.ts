// App-side audit wrapper: binds audit-core to $env and the shared pool.
//
// Two entry points, and the difference is the design:
//   auditIn(client, entry)  joins the caller's transaction and throws, so a
//                           mutation and its record commit together or not at all.
//   audit(entry)            best-effort, for observations with no transaction to
//                           join. Catches everything, logs, never throws: an audit
//                           write must never fail a page view.
// Every Postgres mutation uses auditIn. Neither wraps a call to an external
// service: no transaction spans one, so an audit row around a Sheet write can
// record a change that never landed or lose one that did.

import { env } from '$env/dynamic/private';
import { log } from '$lib/server/log';
import { pgPool } from '$lib/server/postgres';
import {
	actorOf,
	auditBestEffort,
	auditIn,
	recordPrivateValuesFrom,
	startPruner,
	type AuditEntry
} from '$lib/server/audit-core';

export { actorOf, auditIn };
export type { AuditEntry };

export function recordPrivateValues(): boolean {
	return recordPrivateValuesFrom(env);
}

// The pool is built lazily on first use, and building it parses TLS settings
// and reads CA files, any of which can throw. It sits behind the same boundary
// as the write, so a bad POSTGRES_SSL costs an audit row and never a page view.
// The pruner gets the same treatment: it starts at module load in
// hooks.server.ts, where a throw would take the server down with it.
const LAZY_POOL = {
	query: (text: string, values?: unknown[]) => pgPool().query(text, values),
	connect: () => pgPool().connect()
};

export function audit(entry: AuditEntry): Promise<void> {
	return auditBestEffort(LAZY_POOL, entry, (e) =>
		log.error('audit.write-failed', { action: entry.action, error: e as Error })
	);
}

let started = false;

// In-process rather than a compose-only job: an operator who never wires cron
// would keep PII forever, and the retention window is a privacy control. The
// advisory lock in pruneAudit makes the replica that loses the race skip. Not
// itself audited, for the obvious reason; it logs.
export function startAuditPruner(): void {
	if (started) return;
	started = true;
	startPruner(LAZY_POOL, env, log);
}
