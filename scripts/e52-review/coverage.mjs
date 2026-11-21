import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const copy = mkdtempSync(path.join(tmpdir(), 'e52-mutation-'));
try {
  for (const file of ['src', 'skin', 'scripts', 'package.json', 'vite.config.ts', 'svelte.config.js', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js']) {
    cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  symlinkSync(path.join(root, 'node_modules'), path.join(copy, 'node_modules'), 'dir');
  symlinkSync(path.join(root, '.svelte-kit'), path.join(copy, '.svelte-kit'), 'dir');
  const component = path.join(copy, 'src/lib/components/Combobox.svelte');
  const original = readFileSync(component, 'utf8');
  assert.ok(original.includes('<input type="hidden" {name} value={s.value} />'));
  const runKeyboard = () => spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=^E52 R1/R5:', 'src/lib/components/combobox.test.ts'], { cwd: copy, encoding: 'utf8' });
  const baseline = runKeyboard();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  writeFileSync(component, original.replace('<input type="hidden" {name} value={s.value} />', '<input type="hidden" name="wrongField" value={s.value} />'));
  const result = runKeyboard();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.notEqual(result.status, 0, 'R5 keyboard component test must reject a component posting the wrong field name');
} finally { rmSync(copy, { recursive: true, force: true }); }
