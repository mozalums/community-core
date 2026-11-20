import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FieldDef } from './field-schema';
import { memberCsv, type ExportMember } from './member-export';

// The default skin keeps no copy of the address, so the stored Email column
// is exercised on a schema that does.
const SCHEMA: FieldDef[] = [
	{
		key: 'name',
		label: 'Name',
		type: 'text',
		visibility: 'members',
		role: 'name',
		column: 'name',
		order: 10
	},
	{
		key: 'email',
		label: 'Email',
		type: 'email',
		visibility: 'private',
		role: 'email',
		column: 'email',
		order: 20
	}
];

const full = { includePrivate: true, includeRemoved: true };
const member = (emailCopy: unknown): ExportMember => ({
	email: 'login@example.com',
	status: 'active',
	data: { name: 'Ada' },
	privateData: { email: emailCopy, 'x.Login Address': 'login@example.com' }
});

test('R9: full exports retain distinct preserved Email cells beside the login identity', () => {
	const a = memberCsv([member('old-one@example.com')], full, SCHEMA);
	const b = memberCsv([member('old-two@example.com')], full, SCHEMA);
	assert.notEqual(a, b, 'distinct stored Email values must not produce identical full exports');
});

test('R9: the preserved Email field retains structured content too', () => {
	const a = memberCsv([member({ previous: 'old-one@example.com' })], full, SCHEMA);
	const b = memberCsv([member({ previous: 'old-two@example.com' })], full, SCHEMA);
	assert.notEqual(a, b, 'structured stored Email values must not disappear behind member.email');
});
