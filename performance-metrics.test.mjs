import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPerformanceMetrics } from './performance-metrics.mjs';

const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const NOW = 1_000_000;
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-metrics-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metrics.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE thread_metric_snapshots(actor_scope TEXT,local_scope TEXT,thread_id TEXT,revision TEXT,updated_at INTEGER,rollout_size INTEGER,rollout_mtime_ms REAL);
    CREATE TABLE thread_metric_values(actor_scope TEXT,local_scope TEXT,thread_id TEXT,field TEXT,value REAL,measured_at INTEGER,source TEXT,approximate INTEGER,lower_bound INTEGER,observed_since INTEGER,observed_responses INTEGER);
    CREATE TABLE thread_metric_purge_fences(thread_hash TEXT,cutoff_at INTEGER);
    PRAGMA user_version=2;`);
  t.after(() => db.close());
  function put(field, value, extra = {}) {
    const row = { actor: 'private-actor', scope: 'private-scope', id: ID, at: NOW - 5_000,
      source: 'file', approximate: 0, lowerBound: 0, since: null, responses: null, ...extra };
    db.prepare('INSERT INTO thread_metric_values VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.actor, row.scope, row.id, field, value, row.at, row.source, row.approximate, row.lowerBound, row.since, row.responses);
  }
  return { file, db, put };
}

test('absent, incompatible and malformed sources stay unavailable without creating files', t => {
  const { file, db } = fixture(t);
  const missing = file + '.missing';
  assert.equal(readPerformanceMetrics({ dbPath: missing, now: NOW }).available, false);
  assert.equal(fs.existsSync(missing), false);
  db.exec('PRAGMA user_version=99');
  assert.equal(readPerformanceMetrics({ dbPath: file, now: NOW }).available, false);
});

test('only requested UUIDs and numeric provenance leave the reader, with historical age retained', t => {
  const { file, put } = fixture(t);
  put('inputTokens', 20_000, { at: NOW - 86_400_000 });
  // The fixed test clock must also be later than its historical record.
  put('outputTokens', 500, { at: NOW - 90_000 });
  put('cacheHitPercent', 88.5, { id: OTHER });
  put('private-content', 1);
  const result = readPerformanceMetrics({ threadIds: [ID, 'invalid'], dbPath: file, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.sourceAge, 5_000);
  assert.deepEqual(Object.keys(result.byThread), [ID]);
  const fields = result.byThread[ID].fields;
  assert.equal(fields.inputTokens, undefined); // Invalid pre-epoch timestamp.
  assert.equal(fields.outputTokens.value, 500);
  assert.equal(fields.outputTokens.stale, true);
  assert.equal(fields.outputTokens.measuredAt, NOW - 90_000);
  assert.equal(fields.outputTokens.cached, true);
  assert.equal(result.byThread[ID].contextPercent, null);
  const serialized = JSON.stringify(result);
  for (const privateValue of ['private-actor', 'private-scope', OTHER, 'private-content']) assert.ok(!serialized.includes(privateValue));
  assert.deepEqual(Object.keys(readPerformanceMetrics({ dbPath: file, now: NOW }).byThread), []);
});

test('speed requires complete native observation provenance and remains approximate cached telemetry', t => {
  const { file, put } = fixture(t);
  put('tokensPerSecond', 35, { source: 'monitor', approximate: 1, since: NOW - 30_000, responses: 3 });
  put('llmDurationMs', 12_500, { source: 'monitor', approximate: 1 });
  put('firstTokenAvgMs', 2400);
  const fields = readPerformanceMetrics({ threadIds: [ID], dbPath: file, now: NOW }).byThread[ID].fields;
  assert.equal(fields.tokensPerSecond.value, 35);
  assert.equal(fields.tokensPerSecond.approximate, true);
  assert.equal(fields.tokensPerSecond.observedResponses, 3);
  assert.equal(fields.tokensPerSecond.stale, false);
  assert.equal(fields.tokensPerSecond.cached, true);
  assert.equal(fields.llmDurationMs, undefined);
  assert.equal(fields.firstTokenAvgMs.value, 2400);
});

test('ambiguous namespaces, purge fences, future/negative/nonfinite and invalid percentage values stay blank', t => {
  const { file, db, put } = fixture(t);
  put('outputTokens', 100);
  put('outputTokens', 200, { scope: 'another-private-scope' });
  put('inputTokens', 5000, { at: NOW - 10_000 });
  put('cacheHitPercent', 101);
  put('steps', -1);
  put('rounds', 1.5);
  put('toolDurationMs', Infinity);
  put('firstTokenAvgMs', 50, { at: NOW + 1 });
  const hash = createHash('sha256').update(ID).digest('hex');
  db.prepare('INSERT INTO thread_metric_purge_fences VALUES(?,?)').run(hash, NOW - 8_000);
  const result = readPerformanceMetrics({ threadIds: [ID], dbPath: file, now: NOW });
  assert.deepEqual(Object.keys(result.byThread), []);
});

test('reading leaves the metrics database byte for byte unchanged', t => {
  const { file, put } = fixture(t);
  put('outputTokens', 500);
  const before = fs.readFileSync(file);
  const read = readPerformanceMetrics({ threadIds: [ID], dbPath: file, now: NOW });
  assert.equal(read.byThread[ID].fields.outputTokens.value, 500);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('freshness falls back across fields without reviving older values of a malformed latest field', t => {
  const { file, put } = fixture(t);
  put('rounds', 4, { at: NOW - 3_000 });
  put('rounds', 1.5, { at: NOW - 1_000 });
  put('outputTokens', 500, { at: NOW - 10_000 });
  put('private-content', 10, { at: NOW });
  put('steps', 3, { at: NOW + 1 });
  const result = readPerformanceMetrics({ dbPath: file, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.measuredAt, NOW - 10_000);
  assert.equal(result.sourceAge, 10_000);
  assert.deepEqual(Object.keys(result.byThread), []);
});

test('freshness retains the per-field lookup choice when equal timestamps have different validity', t => {
  const { file, db, put } = fixture(t);
  put('rounds', 5.5, { at: NOW - 1_000 });
  put('rounds', 4, { scope: 'another-scope', at: NOW - 1_000 });
  put('steps', 3, { at: NOW - 10_000 });
  const check = () => {
    // Match the reader's existing per-field query, including a source's indexes.
    const latest = db.prepare('SELECT value,measured_at FROM thread_metric_values WHERE field=? AND measured_at<=? ORDER BY measured_at DESC LIMIT 1').get('rounds', NOW);
    const expected = Number.isSafeInteger(latest.value) ? latest.measured_at : NOW - 10_000;
    assert.equal(readPerformanceMetrics({ dbPath: file, now: NOW }).measuredAt, expected);
  };
  check();
  // Index ordering can choose another tied row; the freshness fast path must
  // still agree with the original field-specific lookup.
  db.exec('CREATE INDEX metric_field_time ON thread_metric_values(field,measured_at DESC,value)');
  check();
});

test('freshness stays unavailable when every newest known field is invalid', t => {
  const { file, put } = fixture(t);
  for (const field of ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'firstTokenAvgMs', 'tokensPerSecond', 'cacheHitPercent', 'inputTokens', 'outputTokens']) {
    put(field, -1);
  }
  const result = readPerformanceMetrics({ dbPath: file, now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.measuredAt, null);
  assert.equal(result.sourceAge, null);
});
