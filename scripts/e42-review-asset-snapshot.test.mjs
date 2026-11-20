import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const { stageSkinAssets } = await import(pathToFileURL(resolve('src/lib/skin/assets.js')));

test('R1: a source edit during staging cannot poison a later build of unchanged inputs', () => {
  const scratch = fs.mkdtempSync(join(tmpdir(), 'e42-asset-snapshot-'));
  const core = join(scratch, 'core');
  const skin = join(scratch, 'skin');
  const out = join(scratch, 'out');
  const source = join(skin, 'static/imgs/wordmark.svg');
  const original = '<svg xmlns="http://www.w3.org/2000/svg"><title>original</title></svg>';
  const edited = '<svg xmlns="http://www.w3.org/2000/svg"><title>edited</title></svg>';
  const copy = fs.cpSync;
  try {
    fs.mkdirSync(core);
    fs.mkdirSync(join(skin, 'static/imgs'), { recursive: true });
    fs.writeFileSync(join(core, 'robots.txt'), 'core');
    fs.writeFileSync(source, original);
    let editedDuringCopy = false;
    fs.cpSync = function (src, dest, options) {
      if (src === join(skin, 'static')) {
        // Place an editor's write between source hashing and source copying.
        fs.writeFileSync(source, edited);
        editedDuringCopy = true;
      }
      return copy(src, dest, options);
    };
    syncBuiltinESMExports();
    stageSkinAssets(skin, { core, out });
    fs.cpSync = copy;
    syncBuiltinESMExports();
    fs.writeFileSync(source, original);
    const next = stageSkinAssets(skin, { core, out });
    const got = fs.readFileSync(join(next, 'imgs/wordmark.svg'), 'utf8');
    console.log(JSON.stringify({ editedDuringCopy, source: fs.readFileSync(source, 'utf8'), staged: got }));
    assert.equal(got, original, 'a later build served cached bytes from an edit that was reverted');
  } finally {
    fs.cpSync = copy;
    syncBuiltinESMExports();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
