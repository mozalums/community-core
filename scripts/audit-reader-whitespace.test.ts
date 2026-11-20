import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'vite';

type RenderResult = { body: string; head: string };
test('R9: the reader exposes a retained newline change in short landing text', async () => {
  const server = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
  const dir = mkdtempSync(join(tmpdir(), 'f2-reader-whitespace-'));
  try {
    const { default: Page } = await server.ssrLoadModule('/src/routes/group/[slug]/admin/audit/+page.svelte');
    const { render } = await server.ssrLoadModule('svelte/server') as {
      render(component: unknown, options: Record<string, unknown>): RenderResult;
    };
    const css = (await server.transformRequest('/src/lib/styles/app.css?direct'))!.code;
    const store = (value: unknown) => ({ subscribe(fn: (v: unknown) => void) { fn(value); return () => {}; } });
    const before = '# Public\nPrivate';
    const after = '# Public Private';
    const { renderMarkdown } = await server.ssrLoadModule('/src/lib/server/markdown.ts');
    assert.notEqual(renderMarkdown(before), renderMarkdown(after), 'The edit must change the actual landing output');
    const row = { id: '1', at: '2026-11-14T00:00:00Z', category: 'content', action: 'landing.updated',
      actor: 'review@example.test', targetEmail: null, targetId: null, runId: null, meta: {},
      before: { text: before, length: before.length, truncated: false },
      after: { text: after, length: after.length, truncated: false } };
    const { body } = render(Page, { props: { data: { group: { name: 'Review' }, page: 1, hasMore: false,
      categories: ['content'], filter: { category: '', email: '' }, blocks: [{ runId: null, rows: [row] }] } },
      context: new Map([['__svelte__', { page: store({ url: new URL('http://localhost/admin/audit') }), navigating: store(null), updated: store(false) }]]) });
    const file = join(dir, 'reader.html');
    writeFileSync(file, `<!doctype html><html><head><style>${css}</style></head><body>${body}<script>
      document.querySelectorAll('details').forEach(el => el.open = true);
      const cells = [...document.querySelectorAll('dl > div')];
      const cell = cells.find(el => el.querySelector('dt').textContent === 'text:').querySelector('dd');
      const result = document.createElement('output'); result.id = 'review-result';
      result.textContent = JSON.stringify({ visible: cell.innerText, whitespace: getComputedStyle(cell).whiteSpace });
      document.body.append(result);
    </script></body></html>`);
    const html = execFileSync(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
       `--user-data-dir=${join(dir, 'browser')}`, '--dump-dom', pathToFileURL(file).href],
      { encoding: 'utf8', timeout: 45000, maxBuffer: 10_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(html.match(/<output id="review-result">(.*?)<\/output>/s)![1]
      .replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')) as { visible: string; whitespace: string };
    console.log(JSON.stringify({ storedBefore: before, storedAfter: after, ...result }));
    assert.ok(result.visible.includes(before) && result.visible.includes(after),
      'The reader collapses a retained newline into a space, hiding the entire Markdown change');
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
