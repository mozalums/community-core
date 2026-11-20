import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DEST, destForLog, safeLocalPath } from './callback-path';

// A magic-link token rides in a query string, and a callbackUrl is a path a
// visitor supplies, so `/members?token=…` is a legal thing for someone to ask us
// to store and later log. This is the value that survives into the log stream,
// joined from parts so a secret scanner reading the source does not take it for one.
const TOKEN = ['Zm9vYmFyYmF6cXV4', 'MTIzNDU2Nzg5MGFi', 'Y2RlZmdoaWprbG1ub3A'].join('');

test('a same-origin path is kept verbatim', () => {
	assert.equal(safeLocalPath('/group/moz/members'), '/group/moz/members');
	assert.equal(safeLocalPath('/members?tab=recent'), '/members?tab=recent');
});

test('anything that could leave the origin falls back', () => {
	for (const hostile of [
		'https://evil.example/steal',
		'//evil.example/steal',
		'/\\evil.example/steal',
		'members',
		'',
		null,
		undefined
	]) {
		assert.equal(safeLocalPath(hostile), DEFAULT_DEST, `${hostile} survived as a destination`);
	}
	assert.equal(safeLocalPath(null, '/'), '/', 'the caller-supplied fallback was ignored');
});

test('the logged destination carries no query string', () => {
	const line = destForLog(safeLocalPath(`/members?token=${TOKEN}`));
	assert.equal(line, '/members');
	assert.ok(!line.includes(TOKEN), 'a token reached the log stream through callbackUrl');
});

test('the logged destination carries no fragment', () => {
	assert.equal(destForLog('/group/moz/members#roster'), '/group/moz/members');
});

// The whole point of the field: two members who signed in from different pages
// have to be distinguishable after the fact.
test('the logged destination still separates a deep link from the default', () => {
	assert.notEqual(destForLog('/group/moz/members'), destForLog(DEFAULT_DEST));
	assert.equal(destForLog(DEFAULT_DEST), '/members');
});

// A second copy of the redirect rule drifts from this one: the group landing
// page once carried an inline version that missed `/\`. Every caller goes
// through safeLocalPath, so the rule's tell-tale check appears in one file.
test('no file outside callback-path.ts re-implements the redirect check', async () => {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const root = new URL('..', import.meta.url).pathname;
	const offenders: string[] = [];
	for (const entry of await readdir(root, { recursive: true })) {
		if (!/\.(ts|svelte)$/.test(entry) || entry.endsWith('callback-path.ts')) continue;
		if (entry.endsWith('.test.ts')) continue;
		const source = await readFile(join(root, entry), 'utf8');
		if (/startsWith\(\s*['"]\/\/['"]\s*\)/.test(source)) offenders.push(entry);
	}
	assert.deepEqual(offenders, [], 'call safeLocalPath instead of copying its check');
});

// The group landing page hands its sign-in modal a destination built from
// ?next=. Rendering the real page with LoginModal swapped for a stub that
// prints the prop observes the value the modal would submit, whatever
// expression the page uses to produce it.
test('the group page hands LoginModal a fallback for /\\evil.example', async () => {
	const { createServer } = await import('vite');
	const stubs: Record<string, string> = {
		'/src/lib/components/LoginModal.svelte':
			'<script>let { callbackUrl } = $props();</script><output data-callback={callbackUrl}></output>',
		'/src/lib/components/Landing.svelte': '<script>let {} = $props();</script>'
	};
	const server = await createServer({
		server: { middlewareMode: true, watch: null, hmr: false },
		appType: 'custom',
		plugins: [
			{
				name: 'stub-group-page-children',
				enforce: 'pre',
				load(id) {
					if (id.includes('?')) return undefined;
					const hit = Object.keys(stubs).find((path) => id.endsWith(path));
					return hit ? stubs[hit] : undefined;
				}
			}
		]
	});
	try {
		const { default: Page } = await server.ssrLoadModule('/src/routes/group/[slug]/+page.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');
		const store = <T>(value: T) => ({
			subscribe(fn: (v: T) => void) {
				fn(value);
				return () => {};
			}
		});
		const modalCallback = (pathname: string, next: string): string => {
			const url = new URL(`http://localhost${pathname}`);
			url.searchParams.set('next', next);
			const context = new Map([
				[
					'__svelte__',
					{
						page: store({ url, params: { slug: 'example' } }),
						navigating: store(null),
						updated: store(false)
					}
				]
			]);
			const data = { group: { slug: 'example', name: 'Example' }, user: null, member: false };
			const body: string = render(Page, { props: { data }, context }).body;
			const match = body.match(/data-callback="([^"]*)"/);
			assert.ok(match, 'the group page rendered no LoginModal for a guest');
			return match[1].replaceAll('&amp;', '&');
		};

		assert.equal(modalCallback('/', '/\\evil.example'), '/members');
		assert.equal(modalCallback('/group/example', '/\\evil.example'), '/group/example/members');
		assert.equal(modalCallback('/', '//evil.example'), '/members');
		assert.equal(
			modalCallback('/group/example', '/group/example/admin'),
			'/group/example/admin',
			'a same-origin destination was discarded'
		);
	} finally {
		await server.close();
	}
});
