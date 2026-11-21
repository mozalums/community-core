import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { splitBioLinks, type BioSegment } from './bio-links';

const t = (text: string): BioSegment => ({ kind: 'text', text });
const a = (text: string, href = text): BioSegment => ({ kind: 'link', text, href });

const allText = (input: string) => assert.deepEqual(splitBioLinks(input), [t(input)]);

test('F12 R1: a URL at the start, middle and end of a line becomes a link', () => {
	assert.deepEqual(splitBioLinks('https://example.org/a is mine'), [
		a('https://example.org/a'),
		t(' is mine')
	]);
	assert.deepEqual(splitBioLinks('see https://example.org/a for more'), [
		t('see '),
		a('https://example.org/a'),
		t(' for more')
	]);
	assert.deepEqual(splitBioLinks('find me at https://example.org/a'), [
		t('find me at '),
		a('https://example.org/a')
	]);
});

test('F12 R1: two URLs on one line are two links', () => {
	assert.deepEqual(splitBioLinks('https://a.example.org/ and https://b.example.org/x'), [
		a('https://a.example.org/'),
		t(' and '),
		a('https://b.example.org/x')
	]);
});

test('F12 R1: line breaks and surrounding text pass through unchanged', () => {
	assert.deepEqual(splitBioLinks('Line one\nhttps://example.org/a\n\nLine  three'), [
		t('Line one\n'),
		a('https://example.org/a'),
		t('\n\nLine  three')
	]);
});

test('F12 R1: the scheme matches case-insensitively and the visible text is as written', () => {
	assert.deepEqual(splitBioLinks('HTTPS://Example.ORG/Path'), [
		a('HTTPS://Example.ORG/Path', 'https://example.org/Path')
	]);
});

test('F12 R1: every scheme but https, and a bare www., stays text', () => {
	allText('http://example.org/a');
	allText('javascript:alert(1)');
	allText('data:text/html,<b>x</b>');
	allText('mailto:someone@example.org');
	allText('www.example.org');
	allText('ftp://example.org/a');
	allText('see javascript://example.org/%0aalert(1)');
});

test('F12 R1: markup and quotes stay text, and stop a link', () => {
	allText('<script>alert("x")</script>');
	assert.deepEqual(splitBioLinks('https://example.org/a"onmouseover="x'), [
		a('https://example.org/a'),
		t('"onmouseover="x')
	]);
	assert.deepEqual(splitBioLinks('https://example.org/<script>'), [
		a('https://example.org/'),
		t('<script>')
	]);
	assert.deepEqual(splitBioLinks('<a href="https://example.org/a">'), [
		t('<a href="'),
		a('https://example.org/a'),
		t('">')
	]);
});

test('F12 R2: trailing sentence punctuation is not part of the link', () => {
	assert.deepEqual(splitBioLinks('see https://example.org/a.'), [
		t('see '),
		a('https://example.org/a'),
		t('.')
	]);
	for (const p of ['.', ',', ';', ':', '!', '?', "'", '.)!?']) {
		assert.deepEqual(splitBioLinks(`https://example.org/a${p}`), [
			a('https://example.org/a'),
			t(p)
		]);
	}
	assert.deepEqual(splitBioLinks('https://example.org/a.b,c'), [a('https://example.org/a.b,c')]);
});

test('F12 R2: an unbalanced closing bracket is dropped, a balanced one kept', () => {
	assert.deepEqual(splitBioLinks('(see https://example.org/a)'), [
		t('(see '),
		a('https://example.org/a'),
		t(')')
	]);
	assert.deepEqual(splitBioLinks('[https://example.org/a]'), [
		t('['),
		a('https://example.org/a'),
		t(']')
	]);
	assert.deepEqual(splitBioLinks('(https://en.wikipedia.org/wiki/Foo_(bar))'), [
		t('('),
		a('https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'),
		t(')')
	]);
});

test('F12 R2: a standalone > ends a link and a balanced ] stays in it', () => {
	assert.deepEqual(splitBioLinks('https://example.org/a>b'), [a('https://example.org/a'), t('>b')]);
	assert.deepEqual(splitBioLinks('see https://example.org/a[1] ok'), [
		t('see '),
		a('https://example.org/a[1]'),
		t(' ok')
	]);
});

test('F12 R2: the href is the parsed URL, not the raw text', () => {
	assert.deepEqual(splitBioLinks('https://example.org'), [
		a('https://example.org', 'https://example.org/')
	]);
	assert.deepEqual(splitBioLinks('https://example.org/a b'), [a('https://example.org/a'), t(' b')]);
	assert.deepEqual(splitBioLinks('https://example.org/é'), [
		a('https://example.org/é', 'https://example.org/%C3%A9')
	]);
});

test('F12 R2: https:// alone, a host with no dot, and an unparsable URL stay text', () => {
	allText('https://');
	allText('just https:// here');
	allText('https://.');
	allText('https://localhost');
	allText('https://localhost:8080/admin');
	allText('https://exa mple.org');
	allText('https://[::1');
});

test('F12 R2: a rejected candidate does not swallow a later link', () => {
	assert.deepEqual(splitBioLinks('https://localhost then https://example.org/a'), [
		t('https://localhost then '),
		a('https://example.org/a')
	]);
});

test('F12 R1: empty input and text with no URL are one text segment or none', () => {
	assert.deepEqual(splitBioLinks(''), []);
	allText('Just a bio.\nNo links.');
});

// Node marks each test file's process with NODE_TEST_CONTEXT, and a nested
// `node --test` that inherits it reports to this process over IPC instead of
// printing TAP, which leaves the documentation gate below an empty stdout to
// read. The runner has already consumed the variable by the time hooks run.
before(() => {
	delete process.env.NODE_TEST_CONTEXT;
});

for (const candidate of [
  'https://example.org:bad/https://other.example/path',
  'https://localhost/https://other.example/path'
]) {
  test(`F12 R2: a rejected candidate stays whole: ${candidate}`, () => {
    const bio = `${candidate} then https://valid.example/path`;
    assert.deepEqual(splitBioLinks(bio), [
      { kind: 'text', text: `${candidate} then ` },
      { kind: 'link', text: 'https://valid.example/path', href: 'https://valid.example/path' }
    ]);
  });
}

test('F12 BRANCH-REGRESSION: a 40 KB closing-bracket tail finishes within two seconds', () => {
  const url = 'https://example.org/a';
  const tail = ')'.repeat(40_000);
  const started = Date.now();
  const segments = splitBioLinks(url + tail);
  const elapsed = Date.now() - started;
  assert.deepEqual(segments, [
    { kind: 'link', text: url, href: url },
    { kind: 'text', text: tail }
  ]);
  assert.ok(elapsed < 2_000, `40 KB bio blocked the synchronous render path for ${elapsed} ms`);
});

test('F12 R5: the mapped documentation regression test runs', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx', '--test', '--test-reporter=tap',
    '--test-name-pattern=^F12 R5: Profiles document HTTPS-only bio links$',
    'src/lib/bio-links.test.ts'
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok \d+ - F12 R5: Profiles document HTTPS-only bio links$/m, result.stdout);
});

test('F12 R5: Profiles document HTTPS-only bio links', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../docs/features.md', import.meta.url), 'utf8');
  const profiles = source.match(/^- \*\*Profiles\*\*.*$/m)?.[0] ?? '';
  assert.match(profiles, /bio.*only thing.*`https:\/\/` URL.*becomes a link/);
  assert.match(profiles, /Every other scheme.*Markdown and HTML stay text/);
});
