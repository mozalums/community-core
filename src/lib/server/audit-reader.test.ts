import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'vite';

type RenderResult = { body: string; head: string };
const server = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom' });
after(() => server.close());
const { default: AuditPage } = await server.ssrLoadModule('/src/routes/group/[slug]/admin/audit/+page.svelte');
const { render } = await server.ssrLoadModule('svelte/server') as {
  render(component: unknown, options: Record<string, unknown>): RenderResult;
};
const store = (value: unknown) => ({ subscribe(fn: (v: unknown) => void) { fn(value); return () => {}; } });

test('R9: the audit reader exposes the changed text retained in a landing event', () => {
  const prefix = 'Unchanged introduction. '.repeat(10);
  const before = `${prefix}OLD_ACCOUNT_381`;
  const after = `${prefix}NEW_ACCOUNT_924`;
  const event = {
    id: '1', at: '2026-11-14T00:00:00Z', category: 'content', action: 'landing.updated',
    actor: 'admin@example.test', targetEmail: null, targetId: null, runId: null, meta: {},
    before: { text: before, length: before.length, truncated: false },
    after: { text: after, length: after.length, truncated: false }
  };
  const { body } = render(AuditPage, {
    props: { data: {
      group: { name: 'Review' }, page: 1, hasMore: false,
      categories: ['content'], filter: { category: '', email: '' },
      blocks: [{ runId: null, rows: [event] }]
    } },
    context: new Map([['__svelte__', {
      page: store({ url: new URL('http://localhost/admin/audit') }),
      navigating: store(null), updated: store(false)
    }]])
  });
  console.log(JSON.stringify({
    storedLength: after.length,
    oldTextVisible: body.includes('OLD_ACCOUNT_381'),
    newTextVisible: body.includes('NEW_ACCOUNT_924'),
    expandableDetails: body.includes('<details')
  }));
  assert.ok(body.includes('OLD_ACCOUNT_381') && body.includes('NEW_ACCOUNT_924'),
    'The sole reader hides the entire change even though both values fit within the stored 2,000-character limit');
});
