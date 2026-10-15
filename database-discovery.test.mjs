import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverDatabase } from './database-discovery.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-discovery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const create = (file, sql, mtime) => {
    const filename = path.join(home, file);
    const db = new DatabaseSync(filename);
    try { db.exec(sql); } finally { db.close(); }
    fs.utimesSync(filename, mtime, mtime);
    return filename;
  };
  const discover = () => discoverDatabase({ home, prefix: 'state_', table: 'threads' });
  return { home, create, discover };
}

test('missing and empty data directories stay unavailable without creating files', t => {
  const { home, discover } = fixture(t);
  const missing = path.join(home, 'missing');
  assert.equal(discoverDatabase({ home: missing, prefix: 'state_', table: 'threads' }), null);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(discover(), null);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('corrupt newest candidates are skipped and an older usable database stays read-only', t => {
  const { home, create, discover } = fixture(t);
  const good = create('state_good.sqlite', 'CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES(\'fixture\');', 100);
  const corrupt = path.join(home, 'state_bad.sqlite');
  fs.writeFileSync(corrupt, 'not a sqlite database');
  fs.utimesSync(corrupt, 200, 200);
  const before = fs.readFileSync(good);
  const result = discover();
  assert.ok(result);
  t.after(() => result.db.close());
  assert.equal(result.file, 'state_good.sqlite');
  assert.equal(result.db.prepare('SELECT id FROM threads').get().id, 'fixture');
  assert.throws(() => result.db.exec("INSERT INTO threads VALUES('must not write')"), /readonly|read-only/i);
  assert.deepEqual(fs.readFileSync(good), before);
  assert.deepEqual(fs.readdirSync(home).sort(), ['state_bad.sqlite', 'state_good.sqlite']);
});

test('selection requires a real named table and preserves newest-mtime preference', t => {
  const { create, discover } = fixture(t);
  create('state_old.sqlite', 'CREATE TABLE threads(id TEXT)', 100);
  create('state_new.sqlite', 'CREATE TABLE threads(any_unknown_column TEXT)', 200);
  create('state_view.sqlite', 'CREATE VIEW threads AS SELECT 1 AS id', 300);
  create('state_other.sqlite', 'CREATE TABLE unrelated(id TEXT)', 400);
  create('logs_new.sqlite', 'CREATE TABLE threads(id TEXT)', 500);
  create('state_backup.sqlite.bak', 'CREATE TABLE threads(id TEXT)', 600);
  const result = discover();
  assert.ok(result);
  t.after(() => result.db.close());
  assert.equal(result.file, 'state_new.sqlite');
  assert.equal(result.db.prepare('SELECT count(*) AS count FROM threads').get().count, 0);
});

test('only corrupt or incompatible candidates remain unavailable and never create a source', t => {
  const { home, create, discover } = fixture(t);
  create('state_unknown.sqlite', 'CREATE TABLE unknown_schema(id TEXT)', 100);
  fs.writeFileSync(path.join(home, 'state_bad.sqlite'), 'invalid sqlite');
  fs.mkdirSync(path.join(home, 'state_directory.sqlite'));
  const before = fs.readdirSync(home).sort();
  for (let i = 0; i < 3; i++) assert.equal(discover(), null);
  assert.deepEqual(fs.readdirSync(home).sort(), before);
});

test('failed and unmatched candidates close their handles while the selected handle remains usable', t => {
  const { home, create, discover } = fixture(t);
  create('state_good.sqlite', 'CREATE TABLE threads(id TEXT)', 100);
  create('state_other.sqlite', 'CREATE TABLE unrelated(id TEXT)', 200);
  const corrupt = path.join(home, 'state_bad.sqlite');
  fs.writeFileSync(corrupt, 'invalid sqlite');
  fs.utimesSync(corrupt, 300, 300);
  const closed = [];
  const originalClose = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    originalClose.call(this);
    closed.push(this);
  });
  const result = discover();
  assert.ok(result);
  t.after(() => result.db.close());
  assert.equal(closed.length, 2);
  for (const db of closed) assert.throws(() => db.prepare('SELECT 1'), /not open|closed/i);
  assert.equal(result.db.prepare('SELECT 1 AS value').get().value, 1);
});
