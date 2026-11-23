// A links field in the roster CSV is one column of `site:handle` pairs. Export then import of the same file is a zero-row diff, and a bad
// pair is reported in the preview by row with nothing applied. Runs on the
// default skin, whose `links` field is headed "Links".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memberCsv, type ExportMember } from './member-export';
import { diffImport, parseImport, type RosterMember } from './import-core';

const FULL = { includePrivate: true, includeRemoved: true };

const roster: (RosterMember & ExportMember)[] = [
	{
		id: 'm1',
		email: 'ada@example.org',
		status: 'active',
		data: {
			name: 'Ada',
			links: [
				{ site: 'mastodon', handle: 'ada@mastodon.social' },
				{ site: 'linkedin', handle: 'ada-l' }
			]
		},
		privateData: {}
	},
	{
		id: 'm2',
		email: 'bo@example.org',
		status: 'active',
		data: { name: 'Bo', links: [{ site: 'website', handle: 'https://example.org/bo' }] },
		privateData: {}
	},
	{ id: 'm3', email: 'cy@example.org', status: 'active', data: { name: 'Cy' }, privateData: {} }
];
const storedKeys = new Set(roster.flatMap((m) => Object.keys(m.data)));

const preview = (text: string) => {
	const parsed = parseImport(text, { mode: 'merge', storedKeys });
	return { parsed, diff: parsed.errors.length ? null : diffImport(parsed, roster, 'merge') };
};

test('the export writes one Links column of site:handle pairs, each handle as stored', () => {
	const csv = memberCsv(roster, FULL);
	assert.match(csv, /,Links,/);
	assert.match(csv, /mastodon:ada@mastodon\.social linkedin:ada-l/);
	assert.match(csv, /website:https:\/\/example\.org\/bo/);
	assert.doesNotMatch(csv, /json:/);
});

test('export then import of the same file is a zero-row diff', () => {
	const { parsed, diff } = preview(memberCsv(roster, FULL));
	assert.deepEqual(parsed.errors, []);
	assert.equal(diff!.changed.length, 0, JSON.stringify(diff!.changed));
	assert.equal(diff!.added.length, 0);
	assert.equal(diff!.unchanged, roster.length);
	assert.deepEqual(diff!.errors, []);
});

test('an imported pair goes through the save check, a pasted address becoming its handle', () => {
	const { diff } = preview(
		'Email,Links\r\ncy@example.org,linkedin:https://www.linkedin.com/in/cy-z/?trk=x github:cyz\r\n'
	);
	assert.deepEqual(diff!.changed[0].changes, [
		{
			key: 'links',
			before: undefined,
			after: [
				{ site: 'linkedin', handle: 'cy-z' },
				{ site: 'github', handle: 'cyz' }
			]
		}
	]);
});

test('bad pairs are reported in the preview by row, and nothing is applied', () => {
	const { parsed, diff } = preview(
		[
			'Email,Links',
			'ada@example.org,linkedin:ada-l',
			'bo@example.org,github:bad/handle',
			'cy@example.org,nopair',
			'dee@example.org,github:a github:b'
		].join('\r\n') + '\r\n'
	);
	assert.equal(diff, null);
	assert.deepEqual(parsed.errors, [
		'row 3: Links: GitHub: the part after github.com/.',
		'row 4: Links: "nopair" is not a site:handle pair.',
		'row 5: Links: GitHub: only one link per site.'
	]);
});

test('an import cell naming a site the skin does not offer is a row error', () => {
	const { parsed, diff } = preview('Email,Links\r\nbo@example.org,myspace:bo\r\n');
	assert.equal(diff, null);
	assert.deepEqual(parsed.errors, ['row 2: Links: "myspace" is not a site this community offers.']);
});

test('a json: links cell is a row error', () => {
	const cell = 'json:' + JSON.stringify([{ site: 'github', handle: 'bo' }]);
	const { parsed, diff } = preview(
		`Email,Links\r\nbo@example.org,"${cell.replaceAll('"', '""')}"\r\n`
	);
	assert.equal(diff, null);
	assert.deepEqual(parsed.errors, [
		'row 2: Links: write the links as site:handle pairs, not JSON.'
	]);
});
