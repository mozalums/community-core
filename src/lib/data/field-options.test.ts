import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COUNTRIES, DIALING_CODES, dialingCodeLabel } from './field-options';

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

test('the label leads with the country, so type-ahead finds it', () => {
	assert.equal(dialingCodeLabel('🇺🇸 +1 United States'), 'United States 🇺🇸 +1');
	assert.equal(dialingCodeLabel('🇧🇸 +1-242 Bahamas'), 'Bahamas 🇧🇸 +1-242');
	// Every option relabels; none falls through to the raw string.
	const unchanged = DIALING_CODES.filter((o) => dialingCodeLabel(o) === o);
	assert.deepEqual(unchanged, []);
	// The label starts with the country name a member would type.
	for (const o of DIALING_CODES) assert.ok(dialingCodeLabel(o).startsWith(countryOf(o)));
});

test('a value the sheet has but the list does not is left alone', () => {
	assert.equal(dialingCodeLabel('+1'), '+1');
	assert.equal(dialingCodeLabel(''), '');
});
