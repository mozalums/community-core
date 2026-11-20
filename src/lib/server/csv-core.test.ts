import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BOM, CsvError, formatCsv, guardCell, parseCsv, unguardCell } from './csv-core';

const NASTY = [
	'',
	'plain',
	'Zoë Ó Briain',
	'田中 さくら',
	'comma, inside',
	'say "hi"',
	'"',
	'""',
	'line one\nline two\n\nline four',
	'crlf\r\ninside',
	'bare\rcr',
	'=SUM(A1:A9)',
	'+44 20 7946 0000',
	'-5',
	'@handle',
	'\tleading tab',
	'\rleading cr',
	"'already quoted",
	"''two",
	'trailing space ',
	' leading space',
	'emoji 🦊'
];

test('R4: a cell that opens with = + - @ tab or CR gets one apostrophe', () => {
	for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
		assert.equal(guardCell(`${lead}x`), `'${lead}x`, JSON.stringify(lead));
	}
	assert.equal(guardCell('fine=1'), 'fine=1');
	assert.equal(guardCell(''), '');
	// Excel would evaluate the bytes on disk, so check what is written.
	const out = formatCsv([['=HYPERLINK("http://x","y")', '@SUM(1)']]);
	assert.equal(out, `${BOM}"'=HYPERLINK(""http://x"",""y"")",'@SUM(1)\r\n`);
});

test('R4: the import strips exactly one apostrophe, so the guard round-trips', () => {
	assert.equal(unguardCell("'=1"), '=1');
	assert.equal(unguardCell("''=1"), "'=1");
	assert.equal(unguardCell('=1'), '=1');
	// A value that already starts with an apostrophe is guarded too, or the
	// strip on the way back in would eat a character the member typed.
	assert.equal(guardCell("'tis"), "''tis");
	for (const v of NASTY) assert.equal(unguardCell(guardCell(v)), v, JSON.stringify(v));
});

test('R5: the file opens with the UTF-8 byte order mark', () => {
	const bytes = Buffer.from(formatCsv([['Zoë']]), 'utf8');
	assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
	assert.deepEqual(parseCsv(formatCsv([['Zoë']])), [['Zoë']]);
});

test('R6: quoting follows RFC 4180 and keeps newlines inside a cell', () => {
	assert.equal(
		formatCsv([
			['a', 'b,c', 'say "hi"'],
			['Bio\nsecond line', '']
		]),
		`${BOM}a,"b,c","say ""hi"""\r\n"Bio\nsecond line",\r\n`
	);
	assert.deepEqual(parseCsv('a,"multi\r\nline",c\r\nd,e,f\r\n'), [
		['a', 'multi\r\nline', 'c'],
		['d', 'e', 'f']
	]);
	// Files saved by other tools: LF only, bare CR, no final line break.
	assert.deepEqual(parseCsv('a,b\nc,d'), [
		['a', 'b'],
		['c', 'd']
	]);
	assert.deepEqual(parseCsv('a,b\rc,d\r'), [
		['a', 'b'],
		['c', 'd']
	]);
	assert.deepEqual(parseCsv('a,""\r\n'), [['a', '']]);
	assert.deepEqual(parseCsv('a,\r\n'), [['a', '']]);
});

test('R6: malformed quoting is refused with its line, not guessed at', () => {
	assert.throws(
		() => parseCsv('a,b\r\nc"d,e\r\n'),
		(e) => e instanceof CsvError && e.line === 2
	);
	assert.throws(
		() => parseCsv('a,"open\r\nnever closed'),
		(e) => e instanceof CsvError && e.line === 1
	);
	assert.throws(
		() => parseCsv('"x"y,z'),
		(e) => e instanceof CsvError && /closing quote/.test(e.message)
	);
});

test('R6/R7: parseCsv(formatCsv(rows)) returns the rows unchanged', () => {
	const rows = [NASTY, [...NASTY].reverse(), NASTY.map((v) => v + v)];
	assert.deepEqual(parseCsv(formatCsv(rows)), rows);
	// One cell per row, every value on its own: the edges a wide row can hide.
	const single = NASTY.map((v) => [v]);
	assert.deepEqual(parseCsv(formatCsv(single)), single);
});

test('R7: csv-core is pure, and the exporter formats through it', () => {
	const src = readFileSync(new URL('./csv-core.ts', import.meta.url), 'utf8');
	assert.deepEqual(src.match(/^import .*/gm) ?? [], [], 'csv-core imports nothing');
	const code = src.replace(/^\s*\/\/.*$/gm, '');
	assert.doesNotMatch(code, /\bprocess\.|\$env|node:|\bawait\b|\bfetch\(/);
	const exporter = readFileSync(new URL('./member-export.ts', import.meta.url), 'utf8');
	assert.match(exporter, /from '\.\/csv-core'/);
	assert.doesNotMatch(exporter, /replaceAll\('"'|\\uFEFF/, 'no second escaper in the exporter');
});
