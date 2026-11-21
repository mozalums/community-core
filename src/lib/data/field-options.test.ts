import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as fieldOptions from './field-options';
import { COUNTRIES, DIALING_CODES, matchDialingCode } from './field-options';

// These lists are vendored from the sheet's Lists2 tab and get re-pulled when it
// changes. The order they arrive in is the order the dropdown shows, so the
// country-name ordering is asserted here rather than trusted to hold across the
// next paste.

const countryOf = (option: string) => option.replace(/^\S+\s+\+[\d-]+\s+/, '');

test('every dialling code is flag, code, country', () => {
	const odd = DIALING_CODES.filter((o) => !/^\S+\s+\+[\d-]+\s+\S/.test(o));
	assert.deepEqual(odd, []);
});

test('dialling codes are ordered by country name, not by code', () => {
	const names = DIALING_CODES.map(countryOf);
	assert.deepEqual(
		names,
		[...names].sort((a, b) => a.localeCompare(b, 'en'))
	);
});

test('countries are ordered by name', () => {
	assert.deepEqual(
		COUNTRIES,
		[...COUNTRIES].sort((a, b) => a.localeCompare(b, 'en'))
	);
});

const find = (q: string) => DIALING_CODES.filter((o) => matchDialingCode(o, q)).map(countryOf);

test('E52 R2: typing finds a dialling code by country, code or digits', () => {
	assert.deepEqual(find('uni'), ['United Arab Emirates', 'United Kingdom', 'United States']);
	assert.deepEqual(find('UNITED K'), ['United Kingdom']);
	assert.ok(find('+44').includes('United Kingdom'));
	assert.ok(find('44').includes('United Kingdom'));
	assert.ok(!find('44').includes('United States'));
	assert.deepEqual(find('1-242'), ['Bahamas']);
	assert.deepEqual(find('+1242'), ['Bahamas']);
	// A word start, not any substring: "uni" is inside Tunisia and finds it not.
	assert.ok(!find('uni').includes('Tunisia'));
});

test('E52 R2: matching ignores case and accents, and reaches a country by its other name', () => {
	assert.deepEqual(find('cote'), ['Ivory Coast']);
	assert.deepEqual(find('CÔTE d’'.replace('’', "'")), ['Ivory Coast']);
	assert.deepEqual(find('ivory'), ['Ivory Coast']);
});

test('E52 R2: an off-list value matches by its words, and an empty query matches all', () => {
	assert.equal(matchDialingCode('+81', '81'), true);
	assert.equal(matchDialingCode('+81', '44'), false);
	assert.equal(
		DIALING_CODES.every((o) => matchDialingCode(o, '  ')),
		true
	);
});

test('E52 R4: options show in stored order; no country-first relabel survives', () => {
	assert.equal('dialingCodeLabel' in fieldOptions, false);
});
