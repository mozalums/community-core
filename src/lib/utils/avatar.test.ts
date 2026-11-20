import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initialsFromSubject, nameFromSubject } from './avatar';

// The initials disc is the base layer under every member photo, so these two
// letters are what a visitor sees for anyone without a picture. `member.name`
// is the sheet's first-name cell joined to the last-name cell, and a first-name
// cell often carries a nickname — `Margaret (Maggie)` — which used to make the
// disc read `M(`.

const CASES: Array<[string | null | undefined, string]> = [
	// The reported bug, and the same name with typographic quotes.
	['Margaret (Maggie) Schroeder', 'MS'],
	['Margaret “Maggie” Schroeder', 'MS'],
	['Margaret Schroeder', 'MS'],
	// First and last, not first and second.
	['J. R. R. Tolkien', 'JT'],
	['Ana Maria Gomez', 'AG'],
	// Uppercased however the sheet spells it.
	['mara marsh', 'MM'],
	// Punctuation inside a token is not a token boundary.
	['Jean-Luc Picard', 'JP'],
	// Non-ASCII scripts keep their own letters.
	['Élodie Durand', 'ÉD'],
	['山田 太郎', '山太'],
	// One token: two letters from it.
	['marsh', 'MA'],
	['m@example.com', 'ME'],
	// The subject prefix is stripped before any of this runs.
	['github:marsh', 'MA'],
	['email:matt@example.com', 'MA'],
	// Nothing left to work with.
	['(Maggie)', 'MA'],
	['   ', '??'],
	['', '??'],
	[null, '??'],
	[undefined, '??']
];

for (const [input, expected] of CASES) {
	test(`initialsFromSubject(${JSON.stringify(input)}) → ${expected}`, () => {
		assert.equal(initialsFromSubject(input), expected);
	});
}

test('nameFromSubject strips the scheme half', () => {
	assert.equal(nameFromSubject('github:marsh'), 'marsh');
	assert.equal(nameFromSubject('marsh'), 'marsh');
	// A trailing colon leaves no name, so the whole subject stands in.
	assert.equal(nameFromSubject('github:'), 'github:');
	assert.equal(nameFromSubject(null), '??');
});
