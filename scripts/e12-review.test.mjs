import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.cwd();
const read = (file) => readFileSync(join(root, file), 'utf8');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);

test('R5: the public environment template retires the service account', () => {
  const lines = read('.env.example').split('\n').filter((line) => new RegExp(`${['GOOGLE', 'SA'].join('_')}_(EMAIL|PRIVATE_KEY)`).test(line));
  assert.deepEqual(lines, [], 'the setup template still asks for the retired credential');
});

function filesIn(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}

test('R4: the exact source sweep in the accepted contract is empty', () => {
  const needle = 'google' + 'apis';
  const hits = [...filesIn('src'), ...filesIn('scripts')].flatMap((file) =>
    read(file).split('\n').flatMap((line, index) => line.includes(needle) ? [`${file}:${index + 1}`] : [])
  );
  assert.deepEqual(hits, []);
});

const mapped = [
  ['R9', 'R9: past changelogs still name the sheet-era identifiers, and the sweep is its own entry naming old and new'],
  ['R10', 'R10: the delivery table, the removal plan and the security audit describe the tree after E12']
];
for (const [requirement, name] of mapped) {
  test(`${requirement}: the mapped test belongs to the branch`, () => {
    const found = tracked.filter((file) => /\.test\.[cm]?[jt]s$/.test(file)).some((file) => {
      const source = read(file);
      return ["'", '"'].some((quote) => source.includes('test(' + quote + name + quote));
    });
    assert.ok(found, `no committed test declaration: ${name}`);
  });
}

test('BRANCH-REGRESSION R6: migration 15 refuses an uncoordinated deployment over the old app', {
  skip: process.env.AUDIT_TEST_DATABASE_URL ? false : 'AUDIT_TEST_DATABASE_URL unset'
}, async () => {
  const require = createRequire(join(root, 'package.json'));
  const pg = require('pg');
  const { MIGRATIONS, writerCutoverRefusal } = await import(pathToFileURL(join(root, 'src/lib/server/migrations.ts')).href);
  const client = new pg.Client({ connectionString: process.env.AUDIT_TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA e12_cutover_review');
    await client.query('SET LOCAL search_path TO e12_cutover_review, public');
    await client.query('CREATE TABLE schema_migrations(version integer PRIMARY KEY, name text)');
    for (const migration of MIGRATIONS.filter((m) => m.version <= 14)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations VALUES ($1, $2)', [migration.version, migration.name]);
    }
    await client.query(`INSERT INTO "group" (slug, name) VALUES ('review', 'Review')`);
    const oldSource = execFileSync('git', ['show', 'e3751d2^:src/lib/server/groups.ts'], { cwd: root, encoding: 'utf8' });
    const oldColumns = oldSource.match(/const GROUP_COLS = `([^`]+)`/)[1];
    const oldQuery = `SELECT ${oldColumns} FROM "group" WHERE slug = 'review'`;
    assert.equal((await client.query(oldQuery)).rowCount, 1);
    const refusal = await writerCutoverRefusal(client, undefined);
    if (refusal === null) {
      await client.query(MIGRATIONS.find((m) => m.version === 15).sql);
      await client.query('SAVEPOINT old_reader');
      try {
        await client.query(oldQuery);
      } catch (error) {
        console.log(`old app after migration 15: ${error.code} ${error.message}`);
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT old_reader');
      }
    }
    assert.notEqual(refusal, null, 'ordinary deploy may commit migration 15 before the replacement app is built');
    assert.match(refusal, /15/);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
