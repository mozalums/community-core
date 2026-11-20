import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(force); }
}

async function until(read, accepts) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(50);
  }
  throw new Error('probe timed out');
}

function rpc(socket) {
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data);
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(new Error(JSON.stringify(reply.error)));
    else waiter.resolve(reply.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

test('E42 R3: rendered default skin uses its accent on sign-in and browser chrome', async (t) => {
  const binary = process.env.CHROME_BIN || [
    join(homedir(), 'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/google-chrome'
  ].find(existsSync);
  assert.ok(binary, 'set CHROME_BIN to a Chromium executable');
  assert.ok(existsSync('build/index.js'), 'build with SKIN_DIR=skin/default first');
  const allocation = createServer();
  allocation.listen(0, '127.0.0.1');
  await once(allocation, 'listening');
  const port = allocation.address().port;
  await new Promise((done) => allocation.close(done));
  const profile = mkdtempSync(join(tmpdir(), 'e42-browser-'));
  let server, browser, socket;
  try {
    server = spawn(process.execPath, [resolve('build/index.js')], {
      env: {
        PATH: process.env.PATH, NODE_ENV: 'production', SKIN_DIR: 'skin/default',
        HOST: '127.0.0.1', PORT: String(port),
        MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1',
        PGHOST: '127.0.0.1', PGPORT: '1', PGUSER: 'review', PGPASSWORD: 'review', PGDATABASE: 'review',
        DATABASE_URL: 'postgres://review:review@127.0.0.1:1/review', REDIS_URL: 'redis://127.0.0.1:1'
      }, stdio: 'ignore'
    });
    const url = `http://127.0.0.1:${port}/login`;
    await until(async () => {
      try { return (await fetch(url)).status; } catch { return 0; }
    }, (status) => status === 200);
    browser = spawn(binary, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
      '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    browser.stderr.on('data', (data) => { log += data; });
    const endpoint = await until(() => log.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], Boolean);
    const endpointUrl = new URL(endpoint);
    const tabs = await (await fetch(`http://${endpointUrl.host}/json/list`)).json();
    socket = new WebSocket(tabs.find((tab) => tab.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    const call = rpc(socket);
    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await call('Page.navigate', { url });
    await until(() => evaluate(`!!document.querySelector('button[type="submit"]') && document.readyState === 'complete'`), Boolean);
    await delay(250);
    const snapshot = () => evaluate(`(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--color-accent)';
      document.body.append(probe);
      const accentRgb = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const button = getComputedStyle(document.querySelector('button[type="submit"]'));
      return {
        dark: document.documentElement.classList.contains('dark'),
        accent: root.getPropertyValue('--color-accent').trim(), accentRgb,
        buttonBackground: button.backgroundColor,
        themeColor: document.querySelector('meta[name="theme-color"]').content,
        logoAlt: document.querySelector('main img').alt,
        font: getComputedStyle(document.body).fontFamily
      };
    })()`);
    const light = await snapshot();
    console.log('light', JSON.stringify(light));
    assert.equal(light.logoAlt, 'Example Community');
    assert.match(light.font, /^system-ui/);
    await t.test('R3: sign-in primary background reads the skin accent', () => {
      assert.equal(light.buttonBackground, light.accentRgb);
    });
    await evaluate(`document.querySelector('button[aria-label="Theme"]').click()`);
    await until(() => evaluate(`!!document.querySelector('[role="menuitemradio"]')`), Boolean);
    await evaluate(`[...document.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.trim() === 'Dark').click()`);
    await until(() => evaluate(`document.documentElement.classList.contains('dark')`), Boolean);
    await delay(200);
    const dark = await snapshot();
    console.log('manual dark', JSON.stringify(dark));
    await t.test('R3: browser theme-color follows the active dark accent', () => {
      assert.equal(dark.themeColor, dark.accent);
    });
  } finally {
    socket?.close();
    await stop(browser);
    await stop(server);
    rmSync(profile, { recursive: true, force: true });
  }
});
