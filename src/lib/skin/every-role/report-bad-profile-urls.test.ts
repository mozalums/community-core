import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

// B30 5: the shipped report script, run on every role's fields with only the
// pool stubbed. The default skin has no url field, and `photo` is the avatar
// role. A LinkedIn value migration 22 kept as text is listed by member.

const fixtures = [
	{
		id: 'avatar-only',
		slug: 'example',
		status: 'active',
		data: {},
		private_data: { photo: 'http://example.org/avatar/x' }
	},
	{
		id: 'masked-json',
		slug: 'example',
		status: 'active',
		data: { website: 'javascript:alert(1)' },
		private_data: {}
	},
	{
		id: 'kept-linkedin',
		slug: 'example',
		status: 'active',
		data: { profiles: [{ site: 'github', handle: 'ada' }] },
		private_data: { 'x.linkedin': 'https://example.org/in/ada' }
	},
	{
		id: 'removed-member',
		slug: 'example',
		status: 'removed',
		data: { website: 'http://example.org/removed' },
		private_data: {}
	},
	{
		id: 'twice-bad',
		slug: 'example',
		status: 'active',
		data: { website: 'http://example.org/a' },
		private_data: { photo: 'data:x' }
	},
	{
		id: 'clean',
		slug: 'example',
		status: 'active',
		data: { website: 'https://example.org/c' },
		private_data: { photo: 'https://example.org/avatar/c' }
	}
];
const queries: string[] = [];
const lines: string[] = [];
let finish!: () => void;
const done = new Promise<void>((r) => {
	finish = r;
});
mock.module(new URL('../../../../scripts/db.ts', import.meta.url).href, {
	namedExports: {
		scriptPool: () => ({
			connect: async () => ({
				query: async (sql: string) => {
					queries.push(sql);
					if (/FROM member m/.test(sql)) {
						return {
							rows: fixtures.filter(
								(r) => !/status\s*=\s*'active'/.test(sql) || r.status === 'active'
							)
						};
					}
					return { rows: [] };
				},
				release() {}
			}),
			end: async () => finish()
		})
	}
});
const capture = mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
await import('../../../../scripts/report-bad-profile-urls');
await done;
capture.mock.restore();
const output = lines.join('\n');
const rowsFor = (id: string) => lines.filter((l) => l.includes(`\t${id}\t`));

test('B30 5: the report lists every stored copy the check refuses, avatar and removed members included', () => {
	assert.match(output, /\tavatar-only\tphoto\tprivate_data\t/);
	assert.match(output, /\tmasked-json\twebsite\tdata\t/);
	assert.match(output, /\tremoved-member\twebsite\tdata\t/);
	assert.equal(rowsFor('twice-bad').length, 2);
	assert.equal(rowsFor('clean').length, 0);
});

test('B30 5: a member with several bad values counts once', () => {
	assert.match(output, /^member: 4 of 6 refused, 5 bad values$/m);
});

test('the report lists each LinkedIn value migration 22 kept, by member, with the value', () => {
	assert.match(output, /^member: 1 LinkedIn value\(s\) not converted to links$/m);
	assert.deepEqual(rowsFor('kept-linkedin'), [
		'  example\tkept-linkedin\tx.linkedin\tprivate_data\t"https://example.org/in/ada"'
	]);
	assert.match(output, /^pending request: 0 LinkedIn value\(s\) not converted to links$/m);
});

test('B30 5: the report reads in one read-only transaction and writes nothing', () => {
	assert.equal(queries[0], 'BEGIN READ ONLY');
	assert.equal(queries.at(-1), 'ROLLBACK');
	assert.ok(
		queries.every((q) => /^\s*(BEGIN READ ONLY|SELECT|ROLLBACK)/.test(q)),
		queries.join('\n')
	);
});
