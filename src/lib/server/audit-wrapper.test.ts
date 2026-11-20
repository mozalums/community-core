import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { register } from 'node:module';

type ErrorLine = { message: string; context: Record<string, unknown> };
const errors: ErrorLine[] = [];
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === '$env/dynamic/private') return {
      url: 'data:text/javascript,export const env = {};',
      shortCircuit: true
    };
    return next(specifier, context);
  }
`), import.meta.url);
mock.module('$lib/server/log', {
  namedExports: { log: {
    error(message: string, context: Record<string, unknown>) { errors.push({ message, context }); },
    warn() {}, info() {}, debug() {}
  } }
});
const { env } = await import('$env/dynamic/private');
const { audit, startAuditPruner, recordPrivateValues } = await import('$lib/server/audit');
const { closePool } = await import('$lib/server/postgres');
after(closePool);

test('R2: the public audit entry point catches pool construction failures', async () => {
  env.POSTGRES_SSL = 'invalid';
  await assert.doesNotReject(async () => {
    await audit({ category: 'data', action: 'sync.refused' });
  });
  assert.equal(errors[0]?.message, 'audit.write-failed');
});

test('R5: private-value boot warning survives invalid retention configuration', () => {
  errors.length = 0;
  env.POSTGRES_SSL = 'false';
  env.AUDIT_RETENTION_DAYS = 'ninety';
  env.AUDIT_RECORD_PRIVATE_VALUES = 'true';
  assert.equal(recordPrivateValues(), true);
  startAuditPruner();
  const messages = errors.map(e => e.message);
  assert.ok(messages.includes('audit.private-values.ENABLED'), JSON.stringify(messages));
});
