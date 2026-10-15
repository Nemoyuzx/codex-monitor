import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { collectActivity, createActivityCollector } from './activity-metrics.mjs';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY, source TEXT, agent_nickname TEXT, name TEXT, title TEXT, model TEXT, archived INTEGER DEFAULT 0, tokens_used INTEGER DEFAULT 0, updated_at INTEGER, created_at INTEGER, updated_at_ms INTEGER, created_at_ms INTEGER);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT PRIMARY KEY);
    CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,completed_at_ms INTEGER,item_json TEXT);
    CREATE INDEX items_page ON thread_items(thread_id,rollout_ordinal);
    CREATE INDEX items_turn_page ON thread_items(thread_id,turn_id,rollout_ordinal);
    CREATE TABLE logs(ts INTEGER,level TEXT,target TEXT,feedback_log_body TEXT);
    CREATE TABLE queued_items(created_at_ms INTEGER);
    CREATE TABLE thread_goals(status TEXT);`);
  const options = { historyDb: db, stateDb: db, logsDb: db, queueDb: db, goalsDb: db, now: NOW };
  function thread(id, extra = {}) {
    const row = { id, source: 'vscode', agent_nickname: null, name: null, title: id, model: 'test-model', archived: 0, tokens_used: 100, updated_at: Math.floor(NOW / 1000), created_at: Math.floor((NOW - HOUR) / 1000), updated_at_ms: NOW, created_at_ms: NOW - HOUR, ...extra };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO threads(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
  }
  function item(id, ordinal, extra = {}) {
    const row = { thread_id: id, turn_id: 'turn', item_id: id + '-' + ordinal, item_type: 'commandExecution', rollout_ordinal: ordinal, created_at_ms: NOW - 1000, started_at_ms: NOW - 1000, completed_at_ms: NOW, item_json: JSON.stringify({ status: 'completed', durationMs: 100 }), ...extra };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO thread_items(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
  }
  return { db, options, thread, item };
}

test('missing databases and missing schemas leave unavailable values blank', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const r = collectActivity({ stateDb: db, historyDb: db, logsDb: db, queueDb: db, goalsDb: db, now: NOW });
  assert.ok(Object.values(r.availability).every(value => value === false));
  assert.equal(r.tokens.total, null);
  assert.equal(r.turns.totalRunning, null);
  assert.equal(r.tools.pending, null);
  assert.equal(r.tools.p95Ms, null);
  assert.equal(r.queue.oldestWaitMs, null);
  assert.equal(r.goals.active, null);
  assert.deepEqual(r.sessions.rows, []);
});

test('tool aggregation covers more threads than the visible table and includes failed completions', t => {
  const { thread, item, options } = fixture(t);
  for (let i = 0; i < 12; i++) {
    thread('thread-' + i);
    item('thread-' + i, 1, { completed_at_ms: i === 11 ? null : NOW, item_json: JSON.stringify(i === 11 ? { status: 'inProgress' } : { status: 'completed', durationMs: i * 100, exitCode: i === 10 ? 2 : 0 }) });
  }
  const r = collectActivity({ ...options, threads: 2 });
  assert.equal(r.sessions.rows.length, 2);
  assert.equal(r.tools.window10m.total, 12);
  assert.equal(r.tools.window10m.completed, 10);
  assert.equal(r.tools.window10m.failed, 1);
  assert.equal(r.tools.pending, 1);
  assert.equal(r.tools.completed10m, 11);
  assert.equal(r.tools.failed10m, 1);
  assert.equal(r.tools.success10m, 10);
  assert.equal(r.tools.pendingRows[0].threadId, 'thread-11');
  assert.equal(r.tools.p50Ms, 500);
  assert.equal(r.tools.p95Ms, 1000);
  assert.equal(r.coverage.complete, true);
});

test('long tools completed recently are counted by completion time, independent of creation window', t => {
  const { thread, item, options } = fixture(t);
  thread('long');
  item('long', 1, { created_at_ms: NOW - 2 * HOUR, started_at_ms: NOW - 2 * HOUR, completed_at_ms: NOW - 1000 });
  const r = collectActivity(options);
  assert.equal(r.tools.window10m.total, 0);
  assert.equal(r.tools.window10m.completedDuring, 1);
  assert.equal(r.tools.completed10m, 1);
});

test('duration percentiles use reported or positive observed times and exclude unknowable timing', t => {
  const { thread, item, options } = fixture(t);
  thread('timing');
  item('timing', 1, { item_type: 'webSearch', item_json: '{}', started_at_ms: NOW, completed_at_ms: NOW });
  item('timing', 2, { item_json: JSON.stringify({ status: 'completed', durationMs: 0 }), started_at_ms: NOW, completed_at_ms: NOW });
  item('timing', 3, { item_json: '{}', started_at_ms: NOW - 2000, completed_at_ms: NOW });
  item('timing', 4, { item_json: '{broken json', started_at_ms: null, completed_at_ms: NOW });
  item('timing', 5, { item_json: JSON.stringify({ status: 'failed', durationMs: -1 }), started_at_ms: null, completed_at_ms: NOW });
  const r = collectActivity(options);
  assert.equal(r.tools.window10m.total, 5);
  assert.equal(r.tools.durationSampleCount, 2);
  assert.equal(r.tools.p50Ms, 0);
  assert.equal(r.tools.p95Ms, 2000);
});

test('all running turns are counted separately, old turn metadata is not revived by a newer turn', t => {
  const { db, thread, item, options } = fixture(t);
  thread('same'); thread('old', { updated_at_ms: NOW - HOUR * 5 });
  const insert = db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)');
  insert.run('same', 'new', 'inProgress', Math.floor((NOW - 30000) / 1000));
  insert.run('same', 'old', 'inProgress', Math.floor((NOW - HOUR * 3) / 1000));
  insert.run('old', 'old', 'inProgress', Math.floor((NOW - HOUR * 3) / 1000));
  item('same', 1, { turn_id: 'old', created_at_ms: NOW - HOUR * 2, completed_at_ms: NOW - HOUR * 2 });
  item('same', 2, { turn_id: 'new' });
  item('old', 1, { turn_id: 'old', created_at_ms: NOW - HOUR * 2, completed_at_ms: null, item_json: '{"status":"inProgress"}' });
  const r = collectActivity(options);
  assert.deepEqual(r.turns, { totalRunning: 3, recentRunning: 1, staleRunning: 2 });
  assert.equal(r.sessions.rows.find(row => row.id === 'same').status, 'inProgress');
  assert.equal(r.sessions.rows.find(row => row.id === 'same').runningMs, 30000);
  assert.equal(r.sessions.rows.find(row => row.id === 'old').status, 'stale');
  assert.equal(r.tools.pending, 0);
  assert.equal(r.tools.stalePending, 1);
});

test('agent hierarchy comes from source or spawn edges and Unix-second legacy timestamps work', t => {
  const { db, thread, options } = fixture(t);
  thread('root', { updated_at_ms: null, created_at_ms: null });
  thread('agent', { source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'root', depth: 2 } } }), agent_nickname: 'Agent\u001b[31m', archived: 0 });
  thread('edge-agent', { source: 'vscode' });
  thread('archived', { archived: 1 });
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run('root', 'edge-agent');
  const r = collectActivity(options);
  assert.equal(r.sessions.total, 4);
  assert.equal(r.sessions.main, 1);
  assert.equal(r.sessions.agents, 2);
  assert.equal(r.sessions.archived, 1);
  const agent = r.sessions.rows.find(row => row.id === 'agent');
  assert.equal(agent.parentId, 'root'); assert.equal(agent.depth, 2); assert.equal(agent.model, 'test-model');
  assert.ok(!agent.label.includes('\u001b'));
  assert.equal(r.sessions.rows.find(row => row.id === 'edge-agent').isAgent, true);
  assert.equal(r.sessions.rows.find(row => row.id === 'root').lastActivityAt, NOW);
  assert.equal(r.tokens.total, 400);
  assert.equal(r.tokens.unarchived, 300);
});

test('queue waiting and truly active goals use statuses rather than table row counts', t => {
  const { db, options } = fixture(t);
  db.exec("INSERT INTO thread_goals VALUES('paused'),('complete'),('blocked'),('active'),('active')");
  const queued = db.prepare('INSERT INTO queued_items VALUES(?)'); queued.run(NOW - 1000); queued.run(NOW - 15000);
  const r = collectActivity(options);
  assert.equal(r.goals.total, 5); assert.equal(r.goals.active, 2);
  assert.equal(r.goals.byStatus.paused, 1);
  assert.equal(r.queue.count, 2); assert.equal(r.queue.oldestWaitMs, 15000);
});

test('alerts report a true ten-minute rate and never expose log bodies', t => {
  const { db, options } = fixture(t);
  const log = db.prepare('INSERT INTO logs VALUES(?,?,?,?)');
  log.run(NOW / 1000 - 4, 'WARN', 'codex::network', 'secret-token-do-not-return');
  log.run(NOW / 1000 - 5, 'WARN', 'codex::network', 'user message do not return');
  log.run(NOW / 1000 - 2, 'ERROR', 'codex::server', 'credential do not return');
  log.run(NOW / 1000 - 700, 'ERROR', 'old', 'older');
  const r = collectActivity(options);
  assert.equal(r.alerts.error10m, 1); assert.equal(r.alerts.warn10m, 2);
  assert.equal(r.alerts.errorPerMinute, 0.1); assert.equal(r.alerts.warnPerMinute, 0.2);
  assert.equal(r.alerts.recent[0].target, 'codex::server');
  assert.equal(r.alerts.recent[1].count, 2);
  assert.ok(!JSON.stringify(r).includes('do-not-return'));
  assert.ok(!JSON.stringify(r).includes('credential'));
});

test('cached token totals survive archival, count an increment, and blank on counter regression', t => {
  const { db, thread, options } = fixture(t); thread('tokens');
  const collect = createActivityCollector({ cacheMs: 1 });
  const initial = collect(options);
  assert.equal(initial.tokens.monitorDelta, 0);
  db.exec("UPDATE threads SET tokens_used=150,archived=1 WHERE id='tokens'");
  assert.equal(collect({ ...options, now: NOW + 1000 }), initial, 'minimum five-second cache');
  const second = collect({ ...options, now: NOW + 5000 });
  assert.equal(second.tokens.monitorDelta, 50);
  assert.equal(second.tokens.unarchived, 0);
  db.exec("UPDATE threads SET tokens_used=20 WHERE id='tokens'");
  const reset = collect({ ...options, now: NOW + 10000 });
  assert.equal(reset.tokens.monitorDelta, null); assert.equal(reset.tokens.resetDetected, true);
  assert.equal(reset.tokens.monitorSince, NOW);
  assert.ok(!Object.keys(reset.tokens).some(key => /rate|perSecond|tok.s/iu.test(key)));
});

test('recent tools cap is disclosed and display row count never changes aggregation', t => {
  const { db, thread, item, options } = fixture(t); thread('busy');
  db.exec('BEGIN');
  for (let i = 0; i < 10001; i++) item('busy', i);
  db.exec('COMMIT');
  const r = collectActivity({ ...options, threads: 1 });
  assert.equal(r.coverage.complete, false); assert.equal(r.coverage.recentToolsComplete, false);
  assert.equal(r.coverage.cappedThreads, 1); assert.equal(r.tools.window1h.total, 10000);
  assert.equal(r.tools.durationSampleCount, 2000);
});

function failedQueryReader(db, match) {
  return {
    prepare(sql) {
      if (match(sql)) return { all() { throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }); } };
      return db.prepare(sql);
    },
  };
}

test('a failed query invalidates only its source and never turns unavailable observations into zero', t => {
  for (const [source, option, match, assertBlank] of [
    ['history', 'historyDb', sql => sql.includes('SELECT bounded.item_id'), r => {
      assert.equal(r.tools.window10m.total, null); assert.equal(r.tools.completed10m, null);
      assert.equal(r.tools.pending, null); assert.equal(r.tools.durationSampleCount, null);
      assert.equal(r.turns.totalRunning, null); assert.equal(r.sessions.rows[0].toolsPending, null);
      assert.equal(r.sessions.rows[0].status, 'unknown');
      assert.equal(r.coverage.recentToolsComplete, false);
    }],
    ['state', 'stateDb', sql => sql.includes('SUM(tokens_used)'), r => {
      assert.equal(r.tokens.total, null); assert.equal(r.sessions.total, null);
      assert.equal(r.tools.completed10m, null); assert.deepEqual(r.sessions.rows, []);
    }],
    ['logs', 'logsDb', sql => sql.includes('SELECT level, COUNT(*)'), r => {
      assert.equal(r.alerts.error10m, null); assert.equal(r.alerts.warn10m, null);
      assert.equal(r.alerts.errorPerMinute, null); assert.deepEqual(r.alerts.recent, []);
    }],
    ['queue', 'queueDb', sql => sql.includes('MIN(created_at_ms)'), r => {
      assert.equal(r.queue.count, null); assert.equal(r.queue.oldestWaitMs, null);
    }],
    ['goals', 'goalsDb', sql => sql.includes('FROM thread_goals GROUP BY'), r => {
      assert.equal(r.goals.total, null); assert.equal(r.goals.active, null);
    }],
  ]) {
    const { db, thread, item, options } = fixture(t); thread('observed'); item('observed', 1);
    const r = collectActivity({ ...options, [option]: failedQueryReader(db, match) });
    assert.equal(r.availability[source], false, source);
    assert.equal(r.coverage.complete, false, source);
    assert.deepEqual(r.coverage.failedSources, [source]);
    assert.deepEqual(r.coverage.unavailableSources, [source]);
    for (const [other, available] of Object.entries(r.availability)) if (other !== source) assert.equal(available, true, other);
    assertBlank(r);
  }
});

test('closing a previously queried database invalidates its cached schema availability', t => {
  const db = new DatabaseSync(':memory:');
  let closed = false; t.after(() => { if (!closed) db.close(); });
  db.exec('CREATE TABLE logs(ts INTEGER,level TEXT,target TEXT)');
  const first = collectActivity({ logsDb: db, now: NOW });
  assert.equal(first.availability.logs, true); assert.equal(first.alerts.error10m, 0);
  db.close(); closed = true;
  const second = collectActivity({ logsDb: db, now: NOW + 5000 });
  assert.equal(second.availability.logs, false);
  assert.equal(second.alerts.error10m, null);
  assert.equal(second.alerts.warnPerMinute, null);
  assert.ok(second.coverage.failedSources.includes('logs'));
  assert.equal(second.coverage.complete, false);
});

test('history without turn_id cannot be advertised as an available history source', t => {
  const { db, thread, options } = fixture(t); thread('legacy');
  db.exec('DROP INDEX items_turn_page; ALTER TABLE thread_items DROP COLUMN turn_id');
  const r = collectActivity(options);
  assert.equal(r.availability.history, false);
  assert.equal(r.tools.window1h.total, null);
  assert.equal(r.tools.pending, null);
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.recentToolsComplete, false);
});

test('temporary schema-query failure is retried and can recover on the next sample', t => {
  const { db, options } = fixture(t);
  let busy = true;
  const reader = failedQueryReader(db, sql => busy && sql.startsWith('PRAGMA table_info(logs)'));
  const first = collectActivity({ ...options, logsDb: reader });
  assert.equal(first.availability.logs, false); assert.equal(first.alerts.error10m, null);
  assert.ok(first.coverage.failedSources.includes('logs'));
  busy = false;
  const second = collectActivity({ ...options, logsDb: reader, now: NOW + 5000 });
  assert.equal(second.availability.logs, true); assert.equal(second.alerts.error10m, 0);
  assert.deepEqual(second.coverage.failedSources, []);
});

test('missing or incompatible turns schema leaves item metrics usable but candidate coverage incomplete', t => {
  for (const change of ['DROP TABLE thread_turns', 'ALTER TABLE thread_turns DROP COLUMN status']) {
    const { db, thread, item, options } = fixture(t);
    thread('items-only');
    item('items-only', 1, { completed_at_ms: null, item_json: '{"status":"inProgress"}' });
    db.exec(change);
    const r = collectActivity(options);
    assert.equal(r.availability.history, true);
    assert.equal(r.tools.window10m.total, 1);
    assert.equal(r.tools.pending, 1);
    assert.equal(r.turns.totalRunning, null);
    assert.equal(r.coverage.turnsAvailable, false);
    assert.equal(r.coverage.complete, false);
    assert.equal(r.coverage.pendingComplete, false);
    assert.equal(r.coverage.recentToolsComplete, false);
  }
});

test('interrupted and cancelled tools with completion timestamps are not successful completions', t => {
  const { thread, item, options } = fixture(t); thread('cancelled');
  for (const [index, status] of ['interrupted', 'cancelled', 'canceled', 'declined'].entries()) {
    item('cancelled', index, { completed_at_ms: NOW, item_json: JSON.stringify({ status, durationMs: 100 }) });
  }
  const r = collectActivity(options);
  assert.equal(r.tools.window10m.total, 4);
  assert.equal(r.tools.window10m.other, 4);
  assert.equal(r.tools.window10m.completed, 0);
  assert.equal(r.tools.window10m.failed, 0);
  assert.equal(r.tools.completed10m, 0);
  assert.equal(r.tools.success10m, 0);
  assert.equal(r.tools.pending, 0);
  assert.equal(r.tools.durationSampleCount, 0);
});

test('one sample prepares repeated SQL once per shared connection and the next sample prepares afresh', t => {
  const { db, thread, item, options } = fixture(t);
  for (let i = 0; i < 24; i++) { thread('prepared-' + i); item('prepared-' + i, 1); }
  const prepares = new Map();
  const reader = {
    prepare(sql) {
      prepares.set(sql, (prepares.get(sql) || 0) + 1);
      return db.prepare(sql);
    },
  };
  const sharedOptions = Object.fromEntries(['historyDb', 'stateDb', 'logsDb', 'queueDb', 'goalsDb'].map(key => [key, reader]));
  const first = collectActivity({ ...options, ...sharedOptions });
  assert.equal(first.tools.window10m.total, 24);
  assert.equal(prepares.get('PRAGMA schema_version'), 1);
  assert.ok([...prepares.values()].every(count => count === 1));
  const itemSql = [...prepares.keys()].find(sql => sql.includes('SELECT bounded.item_id'));
  assert.equal(prepares.get(itemSql), 1);
  prepares.clear();
  item('prepared-0', 2);
  const second = collectActivity({ ...options, ...sharedOptions, now: NOW + 5000 });
  assert.equal(second.tools.window10m.total, 25);
  assert.equal(prepares.get(itemSql), 1, 'statement cache is scoped to this sample');
  assert.equal(prepares.get('PRAGMA schema_version'), 1);
  assert.ok([...prepares.values()].every(count => count === 1));
});

test('schema changes reveal newly created tables and added columns on the same connection', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const first = collectActivity({ logsDb: db, stateDb: db, now: NOW });
  assert.equal(first.availability.logs, false);
  db.exec(`CREATE TABLE logs(ts INTEGER,level TEXT,target TEXT);
    INSERT INTO logs VALUES(${NOW / 1000},'WARN','synthetic-target');
    CREATE TABLE threads(id TEXT PRIMARY KEY);
    INSERT INTO threads VALUES('synthetic-thread');`);
  const second = collectActivity({ logsDb: db, stateDb: db, now: NOW + 5000 });
  assert.equal(second.availability.logs, true);
  assert.equal(second.alerts.warn10m, 1);
  assert.equal(second.tokens.total, null);
  assert.equal(second.sessions.recentHour, 0);
  db.exec(`ALTER TABLE threads ADD COLUMN tokens_used INTEGER;
    ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER;
    UPDATE threads SET tokens_used=123,updated_at_ms=${NOW};`);
  const third = collectActivity({ logsDb: db, stateDb: db, now: NOW + 10000 });
  assert.equal(third.tokens.total, 123);
  assert.equal(third.sessions.recentHour, 1);
  assert.equal(third.sessions.rows[0].id, 'synthetic-thread');
});

test('a transient schema-version failure invalidates all affected projections and recovers next sample', t => {
  const { db, options } = fixture(t);
  let busy = true;
  const reader = failedQueryReader(db, sql => busy && sql === 'PRAGMA schema_version');
  const sharedOptions = Object.fromEntries(['historyDb', 'stateDb', 'logsDb', 'queueDb', 'goalsDb'].map(key => [key, reader]));
  const first = collectActivity({ ...options, ...sharedOptions });
  assert.ok(Object.values(first.availability).every(available => available === false));
  assert.deepEqual(new Set(first.coverage.failedSources), new Set(['history', 'state', 'logs', 'queue', 'goals']));
  assert.equal(first.tokens.total, null);
  assert.equal(first.alerts.error10m, null);
  assert.equal(first.tools.pending, null);
  assert.equal(first.queue.count, null);
  assert.equal(first.goals.active, null);
  busy = false;
  const second = collectActivity({ ...options, ...sharedOptions, now: NOW + 5000 });
  assert.ok(Object.values(second.availability).every(available => available === true));
  assert.deepEqual(second.coverage.failedSources, []);
  assert.equal(second.alerts.error10m, 0);
  assert.equal(second.queue.count, 0);
});

test('indexed recent-turn ranges preserve mixed-unit, fractional, future and cutoff membership', t => {
  const { db, item } = fixture(t);
  const now = NOW + 123, cutoff = now - HOUR;
  const starts = [
    null, -1, 0,
    Math.floor(cutoff / 1000), cutoff / 1000 - 0.0001, cutoff / 1000, cutoff / 1000 + 0.0001,
    cutoff - 1, cutoff, cutoff + 1,
    99_999_999_999, 100_000_000_000, 100_000_000_001,
    (now + HOUR) / 1000, now + HOUR,
  ];
  const turn = db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?)');
  for (const [index, startedAt] of starts.entries()) {
    const id = 'boundary-' + index;
    turn.run(id, 'turn', 'completed', startedAt);
    item(id, 1);
  }
  db.exec('CREATE INDEX turns_started_at ON thread_turns(started_at)');
  const expected = db.prepare(`SELECT thread_id FROM thread_turns
    WHERE (CASE WHEN started_at<100000000000 THEN started_at*1000 ELSE started_at END)>=?`).all(cutoff).map(row => row.thread_id).sort();
  let recentQuery;
  const reader = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return { all(...args) {
        if (sql.includes('MAX(started_at) AS last_start')) recentQuery = { sql, args };
        return statement.all(...args);
      } };
    },
  };
  const result = collectActivity({ historyDb: reader, now, threads: 32 });
  assert.deepEqual(result.sessions.rows.map(row => row.id).sort(), expected);
  assert.ok(expected.includes('boundary-13'), 'future-second candidates retain existing semantics');
  assert.ok(expected.includes('boundary-14'), 'future-millisecond candidates retain existing semantics');
  const plan = db.prepare('EXPLAIN QUERY PLAN ' + recentQuery.sql).all(...recentQuery.args);
  assert.ok(plan.some(row => row.detail.includes('SEARCH') && row.detail.includes('turns_started_at')));
});
