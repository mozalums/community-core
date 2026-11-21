import { readFileSync } from 'node:fs';
let source = readFileSync('scripts/e52-review/editor-popup.mjs', 'utf8');
source = source.replace("await box.fill('uni');", `
      await box.focus();
      await box.press('ControlOrMeta+A');
      await box.pressSequentially('uni');
      const cdp = await page.context().newCDPSession(page);
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      const combo = nodes.find(n => n.role?.value === 'combobox' && !n.ignored);
      const popup = nodes.find(n => n.role?.value === 'listbox' && !n.ignored);
      const names = { privateField, combobox: combo?.name?.value, listbox: popup?.name?.value };
      console.log('ACCESSIBLE_NAMES', JSON.stringify(names));
      assert.equal(names.combobox, 'Dialing code');
      assert.ok(names.listbox?.trim(), 'R1: the popup listbox must have an accessible name');
`);
await import('data:text/javascript,' + encodeURIComponent(source));
