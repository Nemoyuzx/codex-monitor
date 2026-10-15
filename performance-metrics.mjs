// Read only the numeric snapshots collected by Codex Usage Badge. A snapshot
// remains cached even when it was measured recently; this module never claims
// that a historical rate is an active generation-speed sample.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FIELDS = ['rounds', 'steps', 'llmDurationMs', 'toolDurationMs', 'firstTokenAvgMs',
  'tokensPerSecond', 'cacheHitPercent', 'inputTokens', 'outputTokens'];
const INTEGERS = new Set(['rounds', 'steps', 'inputTokens', 'outputTokens']);
const STALE_AFTER_MS = 60_000;
const COLUMNS = {
  thread_metric_snapshots: ['actor_scope', 'local_scope', 'thread_id', 'revision', 'updated_at', 'rollout_size', 'rollout_mtime_ms'],
  thread_metric_values: ['actor_scope', 'local_scope', 'thread_id', 'field', 'value', 'measured_at', 'source', 'approximate', 'lower_bound', 'observed_since', 'observed_responses'],
};

export function defaultPerformanceMetricsPath() {
  const base = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CodexUsageBadge')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'CodexUsageBadge')
      : path.join(os.homedir(), '.local', 'share', 'CodexUsageBadge');
  return path.join(base, 'thread-metrics.sqlite');
}

function compatible(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![1, 2].includes(version)) return false;
  const expected = { ...COLUMNS, ...(version === 2 ? { thread_metric_purge_fences: ['thread_hash', 'cutoff_at'] } : {}) };
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  if (tables.length !== Object.keys(expected).length || tables.some(name => !Object.hasOwn(expected, name))) return false;
  return Object.entries(expected).every(([name, columns]) => {
    const actual = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
    return actual.length === columns.length && actual.every((column, i) => column === columns[i]);
  });
}

function cleanField(row, now) {
  if (!FIELDS.includes(row.field) || typeof row.value !== 'number' || !Number.isFinite(row.value)
    || row.value < 0 || row.value > Number.MAX_SAFE_INTEGER
    || INTEGERS.has(row.field) && !Number.isSafeInteger(row.value)
    || row.field === 'cacheHitPercent' && row.value > 100
    || !Number.isSafeInteger(row.measured_at) || row.measured_at < 0 || row.measured_at > now
    || !['file', 'monitor'].includes(row.source) || ![0, 1].includes(row.approximate)
    || ![0, 1].includes(row.lower_bound)) return null;
  const observedSince = Number.isSafeInteger(row.observed_since) && row.observed_since >= 0 && row.observed_since <= row.measured_at
    ? row.observed_since : null;
  const observedResponses = Number.isSafeInteger(row.observed_responses) && row.observed_responses >= 0
    ? row.observed_responses : null;
  // Only the native observer can establish the complete model/tool lifecycle.
  // Totals and file timestamps cannot establish a generation speed.
  if (['tokensPerSecond', 'llmDurationMs'].includes(row.field)
    && (row.source !== 'monitor' || row.approximate !== 1 || row.lower_bound !== 0
      || observedSince === null || !(observedResponses > 0))) return null;
  const ageMs = now - row.measured_at;
  return { value: row.value, measuredAt: row.measured_at, source: row.source,
    approximate: Boolean(row.approximate), lowerBound: Boolean(row.lower_bound),
    ageMs, stale: ageMs > STALE_AFTER_MS, cached: true,
    ...(observedSince === null ? {} : { observedSince }),
    ...(observedResponses === null ? {} : { observedResponses }) };
}

/**
 * Returns cached numeric telemetry for explicitly supplied current thread UUIDs.
 * sourceAge is the age in milliseconds of the newest valid measurement in the
 * source, including threads outside the requested set. No account identifiers,
 * unrelated thread identifiers, conversation text or paths leave this reader.
 * Context is null: this store does not retain a native context snapshot.
 */
export function readPerformanceMetrics({ threadIds = [], dbPath = defaultPerformanceMetricsPath(), now = Date.now() } = {}) {
  const checkedAt = typeof now === 'function' ? now() : now;
  const empty = () => ({ available: false, byThread: Object.create(null), sourceAge: null, measuredAt: null, cached: true });
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0 || typeof dbPath !== 'string') return empty();
  const ids = [...new Set((Array.isArray(threadIds) ? threadIds : [])
    .filter(id => typeof id === 'string' && UUID.test(id)).map(id => id.toLowerCase()))].slice(0, 256);
  let db;
  try {
    if (!fs.lstatSync(dbPath).isFile()) return empty();
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 200 });
    db.exec('PRAGMA query_only=ON');
    if (!compatible(db)) return empty();
    const result = { ...empty(), available: true };
    const projection = 'field,value,measured_at,source,approximate,lower_bound,observed_since,observed_responses';
    // Usually the newest known field is valid, so stop after checking it instead
    // of scanning the entire values table once for each of the nine fields.
    // The outer lookup retains the original per-field ordering for equal stamps.
    // Only numeric snapshots are projected; unrelated thread IDs stay private.
    const latest = db.prepare(`SELECT ${projection} FROM thread_metric_values
      WHERE field=(SELECT field FROM thread_metric_values
        WHERE field IN (${FIELDS.map(() => '?').join(',')}) AND measured_at<=?
        ORDER BY measured_at DESC LIMIT 1)
      AND measured_at<=? ORDER BY measured_at DESC LIMIT 1`).get(...FIELDS, checkedAt, checkedAt);
    const newest = latest && cleanField(latest, checkedAt);
    if (newest) result.measuredAt = newest.measuredAt;
    else if (latest) {
      // A malformed newest value masks older values of that field. Preserve
      // that behavior and inspect the remaining fields, at most nine reads total.
      const nextField = db.prepare(`SELECT ${projection} FROM thread_metric_values WHERE field=? AND measured_at<=? ORDER BY measured_at DESC LIMIT 1`);
      for (const field of FIELDS) {
        if (field === latest.field) continue;
        const row = nextField.get(field, checkedAt);
        const clean = row && cleanField(row, checkedAt);
        if (clean && (result.measuredAt === null || clean.measuredAt > result.measuredAt)) result.measuredAt = clean.measuredAt;
      }
    }
    if (result.measuredAt !== null) result.sourceAge = checkedAt - result.measuredAt;
    if (!ids.length) return result;
    const rows = db.prepare(`SELECT thread_id,${projection} FROM thread_metric_values
      WHERE thread_id IN (${ids.map(() => '?').join(',')}) AND field IN (${FIELDS.map(() => '?').join(',')})`).all(...ids, ...FIELDS);
    const seen = new Map();
    const cutoffs = new Map();
    if (db.prepare('PRAGMA user_version').get().user_version === 2) {
      const get = db.prepare('SELECT cutoff_at FROM thread_metric_purge_fences WHERE thread_hash=?');
      for (const id of ids) {
        const hash = createHash('sha256').update(id).digest('hex');
        const cutoff = get.get(hash)?.cutoff_at;
        if (Number.isSafeInteger(cutoff) && cutoff >= 0) cutoffs.set(id, cutoff);
      }
    }
    for (const row of rows) {
      const id = row.thread_id.toLowerCase();
      if (!ids.includes(id) || cutoffs.has(id) && row.measured_at <= cutoffs.get(id)) continue;
      const entry = cleanField(row, checkedAt);
      if (!entry) continue;
      const key = `${id}:${row.field}`;
      // Multiple account/storage namespaces for one UUID cannot be resolved by
      // this read-only integration. Keep ambiguous fields blank.
      if (seen.has(key)) { seen.set(key, null); continue; }
      seen.set(key, { id, field: row.field, entry });
    }
    for (const record of seen.values()) {
      if (!record) continue;
      result.byThread[record.id] ??= { fields: Object.create(null), contextPercent: null };
      result.byThread[record.id].fields[record.field] = record.entry;
    }
    return result;
  } catch { return empty(); }
  finally { try { db?.close(); } catch {} }
}
