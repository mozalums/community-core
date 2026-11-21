import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyticsTag } from './analytics.js';

const fathom = { provider: 'fathom', site: 'ABCDEFGH' } as const;

test('E53 R3: the Fathom tag carries data-honor-dnt="true"', () => {
	assert.deepEqual(analyticsTag(fathom, {}), {
		src: 'https://cdn.usefathom.com/script.js',
		'data-site': 'ABCDEFGH',
		'data-spa': 'auto',
		'data-honor-dnt': 'true'
	});
	assert.equal(analyticsTag(fathom, { globalPrivacyControl: false })?.['data-honor-dnt'], 'true');
});

test('E53 R3: a browser sending Global Privacy Control gets no analytics tag', () => {
	assert.equal(analyticsTag(fathom, { globalPrivacyControl: true }), null);
	assert.equal(analyticsTag(undefined, {}), null);
});

test('E53 R3: the layout builds its tag from navigator after mount, not on the server', () => {
	const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
	assert.match(layout, /onMount\(\(\) => \{\s*tracker = analyticsTag\(analytics, navigator\);\s*\}\)/);
	assert.match(layout, /let tracker = \$state<.+>\(null\);/);
	assert.doesNotMatch(layout, /ANALYTICS_PROVIDERS/);
});
