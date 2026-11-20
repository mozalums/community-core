import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('R1: concurrent Svelte config readers do not fail while staging assets', async () => {
  const root = resolve('.');
  const scratch = mkdtempSync(join(tmpdir(), 'e42-config-race-'));
  const children = [];
  try {
    for (const entry of ['package.json', 'svelte.config.js', 'src/lib/skin', 'skin', 'static']) {
      cpSync(join(root, entry), join(scratch, entry), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
    const readers = Array.from({ length: 6 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { once } from 'node:events';
        process.send('ready');
        await once(process, 'message');
        try {
          for (let i = 0; i < 12; i++) await import('./svelte.config.js?read=' + i);
        } finally { process.disconnect(); }
      `], {
        cwd: scratch,
        env: { PATH: process.env.PATH, SKIN_DIR: 'skin/default' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      let stderr = '';
      child.stderr.on('data', (data) => { stderr += data; });
      const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, stderr }));
      const ready = once(child, 'message');
      children.push({ child, exited });
      return { child, ready, exited };
    });
    await Promise.all(readers.map((r) => r.ready));
    for (const { child } of readers) child.send('go');
    const results = await Promise.all(readers.map((r) => r.exited));
    const failures = results.filter((r) => r.code !== 0);
    assert.deepEqual(failures, [], 'config readers raced: ' + JSON.stringify(failures));
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.all(children.map((r) => r.exited));
    rmSync(scratch, { recursive: true, force: true });
  }
});
