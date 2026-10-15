import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDatabaseRegistry, discoverDatabase } from './database-discovery.mjs';

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

function registryFixture(t) {
  const files = fixture(t);
  let time = 0;
  const registry = createDatabaseRegistry({
    home: files.home,
    sources: { state: { prefix: 'state_', table: 'threads' }, logs: { prefix: 'logs_', table: 'logs' } },
    now: () => time,
  });
  t.after(() => registry.close());
  return { ...files, registry, at: value => { time = value; } };
}

const THREADS_SQL = "CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES('first')";

test('registry discovers sources created after startup and refreshes all keys together', t => {
  const { create, registry, at } = registryFixture(t);
  assert.deepEqual(registry.refresh(), { state: null, logs: null });
  create('state_1.sqlite', THREADS_SQL, 100);
  create('logs_1.sqlite', 'CREATE TABLE logs(message TEXT)', 100);
  at(4999);
  assert.deepEqual(registry.refresh(), { state: null, logs: null });
  at(5000);
  const result = registry.refresh();
  assert.equal(result.state.file, 'state_1.sqlite');
  assert.equal(result.logs.file, 'logs_1.sqlite');
});

test('registry discovers a directory created later without creating missing files itself', t => {
  const { home } = fixture(t);
  const lateHome = path.join(home, 'not-created-yet');
  const registry = createDatabaseRegistry({ home: lateHome, sources: { state: { prefix: 'state_', table: 'threads' } } });
  t.after(() => registry.close());
  assert.deepEqual(registry.refresh(), { state: null });
  assert.equal(fs.existsSync(lateHome), false);
  fs.mkdirSync(lateHome);
  const writer = new DatabaseSync(path.join(lateHome, 'state_1.sqlite'));
  writer.exec(THREADS_SQL);
  writer.close();
  assert.equal(registry.refresh({ force: true }).state.file, 'state_1.sqlite');
});

test('registry reuses a valid connection during normal writes and mtime changes', t => {
  const { create, registry, at } = registryFixture(t);
  const filename = create('state_1.sqlite', THREADS_SQL, 100);
  const first = registry.refresh().state;
  const writer = new DatabaseSync(filename);
  writer.exec("INSERT INTO threads VALUES('second')");
  writer.close();
  fs.utimesSync(filename, 300, 300);
  const close = t.mock.method(DatabaseSync.prototype, 'close');
  at(5000);
  const next = registry.refresh().state;
  assert.equal(next, first);
  assert.equal(next.db.prepare('SELECT count(*) AS count FROM threads').get().count, 2);
  assert.equal(close.mock.callCount(), 0);
});

test('registry validates a newer source before closing the old connection', t => {
  const { create, registry, at } = registryFixture(t);
  create('state_1.sqlite', THREADS_SQL, 100);
  const first = registry.refresh().state;
  create('state_2.sqlite', "CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES('new')", 200);
  const closed = [];
  let replacement;
  const originalPrepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (this !== first.db && sql === 'SELECT 1 FROM "threads" LIMIT 1') replacement = this;
    return originalPrepare.call(this, sql);
  });
  const originalClose = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    if (this === first.db) {
      assert.equal(this.prepare('SELECT id FROM threads').get().id, 'first');
      assert.equal(replacement.prepare('SELECT id FROM threads').get().id, 'new');
    }
    closed.push(this);
    return originalClose.call(this);
  });
  at(5000);
  const next = registry.refresh().state;
  assert.equal(next.file, 'state_2.sqlite');
  assert.equal(next.db.prepare('SELECT id FROM threads').get().id, 'new');
  assert.deepEqual(closed, [first.db]);
  assert.throws(() => first.db.prepare('SELECT 1'), /not open|closed/i);
});

test('registry skips corrupt or incompatible new candidates and preserves the existing source', t => {
  const { home, create, registry, at } = registryFixture(t);
  create('state_1.sqlite', THREADS_SQL, 100);
  const first = registry.refresh().state;
  create('state_unknown.sqlite', 'CREATE TABLE other(id TEXT)', 200);
  const bad = path.join(home, 'state_bad.sqlite');
  fs.writeFileSync(bad, 'corrupt sqlite');
  fs.utimesSync(bad, 300, 300);
  const closed = [];
  const originalClose = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    closed.push(this);
    return originalClose.call(this);
  });
  at(5000);
  assert.equal(registry.refresh().state, first);
  assert.equal(closed.length, 2);
  assert.equal(closed.includes(first.db), false);
  for (const db of closed) assert.throws(() => db.prepare('SELECT 1'), /not open|closed/i);
});

test('registry replaces a connection when the same pathname gets a new inode', t => {
  const { home, create, registry, at } = registryFixture(t);
  const filename = create('state_1.sqlite', THREADS_SQL, 100);
  const first = registry.refresh().state;
  const replacement = create('replacement.sqlite', "CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES('replacement')", 100);
  fs.renameSync(replacement, filename);
  at(5000);
  const next = registry.refresh().state;
  assert.equal(next.file, first.file);
  assert.notEqual(next.db, first.db);
  assert.equal(next.db.prepare('SELECT id FROM threads').get().id, 'replacement');
  assert.throws(() => first.db.prepare('SELECT 1'), /not open|closed/i);
  assert.deepEqual(fs.readdirSync(home), ['state_1.sqlite']);
});

test('registry rejects a candidate swapped while opening and closes its discarded handle', t => {
  const { create, registry, at } = registryFixture(t);
  create('state_1.sqlite', THREADS_SQL, 100);
  const first = registry.refresh().state;
  const filename = create('state_2.sqlite', THREADS_SQL, 200);
  const replacement = create('replacement.sqlite', "CREATE TABLE threads(id TEXT); INSERT INTO threads VALUES('replacement')", 300);
  let swapped = false;
  const discarded = [];
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalClose = DatabaseSync.prototype.close;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (!swapped && this !== first.db) {
      swapped = true;
      fs.renameSync(replacement, filename);
    }
    return originalPrepare.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function () {
    discarded.push(this);
    return originalClose.call(this);
  });
  at(5000);
  assert.equal(registry.refresh().state, first);
  assert.equal(discarded.length, 1);
  assert.throws(() => discarded[0].prepare('SELECT 1'), /not open|closed/i);
  at(10000);
  const next = registry.refresh().state;
  assert.equal(next.file, 'state_2.sqlite');
  assert.equal(next.db.prepare('SELECT id FROM threads').get().id, 'replacement');
  assert.throws(() => first.db.prepare('SELECT 1'), /not open|closed/i);
});

test('registry falls back after deletion and releases a source when all candidates disappear', t => {
  const { home, create, registry, at } = registryFixture(t);
  create('state_old.sqlite', THREADS_SQL, 100);
  const newest = create('state_new.sqlite', THREADS_SQL, 200);
  const first = registry.refresh().state;
  fs.unlinkSync(newest);
  at(5000);
  const fallback = registry.refresh().state;
  assert.equal(fallback.file, 'state_old.sqlite');
  assert.throws(() => first.db.prepare('SELECT 1'), /not open|closed/i);
  fs.unlinkSync(path.join(home, 'state_old.sqlite'));
  at(10000);
  assert.equal(registry.refresh().state, null);
  assert.throws(() => fallback.db.prepare('SELECT 1'), /not open|closed/i);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('registry detects in-place corruption despite SQLite cached pages and can recover later', t => {
  const { create, registry, at } = registryFixture(t);
  create('state_old.sqlite', THREADS_SQL, 100);
  const newest = create('state_new.sqlite', THREADS_SQL, 200);
  const originalBytes = fs.readFileSync(newest);
  const first = registry.refresh().state;
  assert.equal(first.db.prepare('SELECT id FROM threads').get().id, 'first');
  fs.writeFileSync(newest, 'overwritten while open');
  at(5000);
  const fallback = registry.refresh().state;
  assert.equal(fallback.file, 'state_old.sqlite');
  assert.throws(() => first.db.prepare('SELECT 1'), /not open|closed/i);
  fs.writeFileSync(newest, originalBytes);
  at(10000);
  const recovered = registry.refresh().state;
  assert.equal(recovered.file, 'state_new.sqlite');
  assert.equal(recovered.db.prepare('SELECT id FROM threads').get().id, 'first');
});

test('registry detects a dropped required table and can reopen a caller-closed handle', t => {
  const { create, registry, at } = registryFixture(t);
  const filename = create('state_1.sqlite', THREADS_SQL, 100);
  const first = registry.refresh().state;
  first.db.close();
  at(5000);
  const reopened = registry.refresh().state;
  assert.notEqual(reopened.db, first.db);
  const writer = new DatabaseSync(filename);
  writer.exec('DROP TABLE threads');
  writer.close();
  at(10000);
  assert.equal(registry.refresh().state, null);
  assert.throws(() => reopened.db.prepare('SELECT 1'), /not open|closed/i);
});

test('registry throttles scans but refreshes on force and wall-clock rollback', t => {
  const { create, registry, at } = registryFixture(t);
  create('state_1.sqlite', THREADS_SQL, 100);
  const readdir = t.mock.method(fs, 'readdirSync');
  at(10000);
  const first = registry.refresh();
  at(14999);
  assert.equal(registry.refresh(), first);
  assert.equal(readdir.mock.callCount(), 1);
  registry.refresh({ force: true });
  assert.equal(readdir.mock.callCount(), 2);
  at(1000);
  registry.refresh();
  assert.equal(readdir.mock.callCount(), 3);
  at(5999);
  registry.refresh();
  assert.equal(readdir.mock.callCount(), 3);
  at(6000);
  registry.refresh();
  assert.equal(readdir.mock.callCount(), 4);
});

test('registry stays read-only and close releases every selected connection exactly once', t => {
  const { home, create, registry } = registryFixture(t);
  const state = create('state_1.sqlite', THREADS_SQL, 100);
  const logs = create('logs_1.sqlite', 'CREATE TABLE logs(message TEXT)', 100);
  const before = [fs.readFileSync(state), fs.readFileSync(logs)];
  const result = registry.refresh();
  assert.throws(() => result.state.db.exec("INSERT INTO threads VALUES('not allowed')"), /readonly|read-only/i);
  const close = t.mock.method(DatabaseSync.prototype, 'close');
  registry.close();
  registry.close();
  assert.deepEqual(registry.refresh({ force: true }), { state: null, logs: null });
  assert.equal(close.mock.callCount(), 2);
  assert.deepEqual(fs.readFileSync(state), before[0]);
  assert.deepEqual(fs.readFileSync(logs), before[1]);
  assert.deepEqual(fs.readdirSync(home).sort(), ['logs_1.sqlite', 'state_1.sqlite']);
});
