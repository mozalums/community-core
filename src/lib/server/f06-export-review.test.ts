import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv } from './csv-core';
import { memberCsv, type ExportMember } from './member-export';

const full = { includePrivate: true, includeRemoved: true };
const member = (data: Record<string, unknown>, privateData: Record<string, unknown>): ExportMember => ({
	email: 'ada@example.com', status: 'active', data, privateData
});

test('R9: a full export carries both preserved Status headers', () => {
	const stored = member({}, { 'x.Status': 'one', 'x.x.Status': 'two' });
	const [head, row] = parseCsv(memberCsv([stored], full));
	assert.equal(new Set(head).size, head.length);
	assert.ok(row.includes('one') && row.includes('two'));
});

test('R9: a full export distinguishes x.Status from x.x.Status', () => {
	const a = memberCsv([member({}, { 'x.Status': 'one' })], full);
	const b = memberCsv([member({}, { 'x.x.Status': 'one' })], full);
	assert.notEqual(a, b, 'different stored keys must not produce identical full exports');
});

test('R9: a full export retains the content of stored objects', () => {
	const a = memberCsv([member({}, { 'x.Team': { unit: 'ops' } })], full);
	const b = memberCsv([member({}, { 'x.Team': { unit: 'engineering' } })], full);
	assert.notEqual(a, b, 'different stored objects must not produce identical full exports');
});

test('R9: a full export retains the boundaries of stored array elements', () => {
	const a = memberCsv([member({ bio: ['a,b', 'c'] }, {})], full);
	const b = memberCsv([member({ bio: ['a', 'b,c'] }, {})], full);
	assert.notEqual(a, b, 'different stored arrays must not produce identical full exports');
});
