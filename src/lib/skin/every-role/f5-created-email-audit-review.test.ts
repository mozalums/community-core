import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import type { Client } from '../../server/member-write-core';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// createMemberIn reads the field schema, and the default skin keeps no copy
// of the address to redact.
const { AUDIT_INSERT_SQL } = await import('../../server/audit-core');
const { createMemberIn } = await import('../../server/member-write-core');

type Statement = { sql: string; values: unknown[] };

test('review R10: member creation retains the private Email presence marker after audit serialization', async () => {
	const statements: Statement[] = [];
	const memberId = '00000000-0000-4000-8000-000000000002';
	const client = {
		query: async (sql: string, values: unknown[] = []) => {
			statements.push({ sql, values });
			return {
				rows: /INSERT INTO member/.test(sql) ? [{ id: memberId }] : [],
				rowCount: 1
			};
		}
	} as unknown as Client;
	await createMemberIn(client, {
		group: { id: '00000000-0000-4000-8000-000000000001', slug: 'review-f5' },
		actor: { actorSubject: 'review:admin', actorEmail: 'admin@example.org' },
		email: 'member@example.org',
		values: { givenName: 'Ada', email: 'member@example.org' },
		recordPrivateValues: false
	});
	const audits = statements.filter((s) => s.sql === AUDIT_INSERT_SQL);
	assert.equal(audits.length, 1);
	const values = audits[0].values;
	const stored = {
		after: JSON.parse(values[10] as string),
		meta: JSON.parse(values[11] as string)
	};
	assert.deepEqual(
		stored,
		{
			after: { givenName: 'Ada', email: '<set>' },
			meta: { redacted: ['email'] }
		},
		JSON.stringify(stored)
	);
});
