// Read-only, bounded summaries of Codex's existing SQLite projections.
// No rollout files, tool arguments/results, message bodies, or log bodies are read.
const HOUR = 3_600_000;
const TEN_MINUTES = 600_000;
const TOOL_SQL = "('commandExecution','mcpToolCall','dynamicToolCall','collabAgentToolCall','webSearch')";
const MAX_THREADS = 256;
const MAX_ITEMS_PER_THREAD = 10_000;
const MAX_DURATION_SAMPLES = 2_000;
const schemas = new WeakMap();
const SCHEMA_KEY = Symbol('schemaKey');

function trackedReader(db, source, failures) {
  if (!db) return null;
  return {
    [SCHEMA_KEY]: db,
    prepare(sql) {
      return {
        all(...args) {
          try { return db.prepare(sql).all(...args); }
          catch (error) { failures.add(source); throw error; }
        },
      };
    },
  };
}

function columns(db, table) {
  if (!db) return new Set();
  const schemaKey = db[SCHEMA_KEY] || db;
  let tables = schemas.get(schemaKey);
  if (!tables) { tables = new Map(); schemas.set(schemaKey, tables); }
  if (!tables.has(table)) {
    try { tables.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))); }
    catch { return new Set(); } // Retry transient schema-query failures on the next sample.
  }
  return tables.get(table);
}
function has(db, table, fields) { const names = columns(db, table); return fields.every(name => names.has(name)); }
function query(db, sql, ...args) { try { return db ? db.prepare(sql).all(...args) : []; } catch { return []; } }
function get(db, sql, ...args) { return query(db, sql, ...args)[0] || null; }
function value(row, key) { return row && row[key] != null ? Number(row[key]) : null; }
function ms(timestamp) {
  const n = Number(timestamp);
  return timestamp == null || !Number.isFinite(n) || n <= 0 ? null : n < 100_000_000_000 ? n * 1_000 : n;
}
function clean(text, max = 100) { return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max); }
function age(now, timestamp) { return timestamp == null ? null : Math.max(0, now - timestamp); }
function quantile(sorted, percentile) { return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] : null; }
function blankWindow() { return { total: 0, completed: 0, failed: 0, pending: 0, other: 0, completedDuring: 0, failedDuring: 0 }; }
function unavailableWindow() { return Object.fromEntries(Object.keys(blankWindow()).map(key => [key, null])); }
function sourceInfo(source) {
  try {
    const parsed = JSON.parse(source);
    const spawn = parsed?.subagent?.thread_spawn;
    return { isAgent: !!parsed?.subagent, parentId: spawn?.parent_thread_id || null, depth: Number(spawn?.depth) || (parsed?.subagent ? 1 : 0) };
  } catch { return { isAgent: source === 'subagent', parentId: null, depth: source === 'subagent' ? 1 : 0 }; }
}
function timestampExpr(names, millis, seconds, fallback = 'NULL') {
  if (names.has(millis) && names.has(seconds)) return `COALESCE(${millis}, ${seconds} * 1000)`;
  return names.has(millis) ? millis : names.has(seconds) ? `${seconds} * 1000` : fallback;
}
function addOutcome(window, outcome) { window.total++; window[outcome]++; }
function toolOutcome(row) {
  if (['failed', 'errored', 'error'].includes(row.tool_status) || (row.exit_code != null && Number(row.exit_code) !== 0) || row.has_error === 1) return 'failed';
  if (['interrupted', 'cancelled', 'canceled', 'declined'].includes(row.tool_status)) return 'other';
  if (row.completed_at_ms != null || ['completed', 'succeeded', 'success'].includes(row.tool_status)) return 'completed';
  return 'pending';
}
function toolDuration(row) {
  if (row.reported_duration != null && Number.isFinite(Number(row.reported_duration)) && Number(row.reported_duration) >= 0) return Number(row.reported_duration);
  // Projection timestamps can both be assigned during ingestion. Equal stamps
  // do not establish a zero-duration execution when no duration was reported.
  const start = Number(row.started_at_ms), end = Number(row.completed_at_ms);
  return row.started_at_ms != null && row.completed_at_ms != null && end > start ? end - start : null;
}

/**
 * Stateless snapshot. Nullable values mean unavailable, never a fabricated zero.
 * Tool windows are grouped by item creation time, not completion time. Durations
 * use at most the 2,000 newest completed/failed tools with recorded timing.
 * Pending scope: all recent threads and all inProgress turns (not top-N UI rows).
 */
export function collectActivity({ historyDb = null, stateDb = null, logsDb = null, queueDb = null, goalsDb = null, now = Date.now(), limit = 8, threads = limit } = {}) {
  now = Number(now);
  if (!Number.isFinite(now)) now = Date.now();
  limit = Math.max(1, Math.min(32, Math.trunc(Number(threads)) || 8));
  const cutoff = now - HOUR;
  const queryFailures = new Set();
  historyDb = trackedReader(historyDb, 'history', queryFailures);
  stateDb = trackedReader(stateDb, 'state', queryFailures);
  logsDb = trackedReader(logsDb, 'logs', queryFailures);
  queueDb = trackedReader(queueDb, 'queue', queryFailures);
  goalsDb = trackedReader(goalsDb, 'goals', queryFailures);
  const availability = {
    history: has(historyDb, 'thread_items', ['thread_id', 'turn_id', 'item_id', 'item_type', 'rollout_ordinal', 'created_at_ms', 'started_at_ms', 'completed_at_ms', 'item_json']),
    state: has(stateDb, 'threads', ['id']),
    logs: has(logsDb, 'logs', ['ts', 'level', 'target']),
    queue: has(queueDb, 'queued_items', ['created_at_ms']),
    goals: has(goalsDb, 'thread_goals', ['status']),
  };
  const turnsAvailable = has(historyDb, 'thread_turns', ['thread_id', 'turn_id', 'status', 'started_at']);
  const result = {
    sampledAt: now, availability,
    coverage: { complete: turnsAvailable, recentToolsComplete: turnsAvailable, pendingComplete: turnsAvailable, turnsAvailable, threads: 0, maxThreads: MAX_THREADS, maxItemsPerThread: MAX_ITEMS_PER_THREAD, cappedThreads: 0, pendingScope: 'recent-or-running-threads', durationSampleLimit: MAX_DURATION_SAMPLES },
    sessions: { total: null, main: null, agents: null, archived: null, recentHour: null, rows: [] },
    turns: { recentRunning: null, staleRunning: null, totalRunning: null },
    tools: { window10m: blankWindow(), window1h: blankWindow(), byType: [], pending: null, stalePending: null, pendingRows: [], oldestPendingMs: null, completed10m: null, success10m: null, failed10m: null, durationSampleCount: 0, p50Ms: null, p95Ms: null },
    tokens: { total: null, unarchived: null, totalThreads: null, monitorDelta: null, monitorSince: null, resetDetected: false },
    alerts: { error10m: null, warn10m: null, errorPerMinute: null, warnPerMinute: null, recent: [] },
    queue: { count: null, oldestWaitMs: null },
    goals: { total: null, active: null, byStatus: {} },
  };
  const candidates = new Map();
  const runningByThread = new Map();
  let recentRunning = 0, staleRunning = 0;
  const threadCols = columns(stateDb, 'threads');
  const updatedExpr = timestampExpr(threadCols, 'updated_at_ms', 'updated_at');
  const createdExpr = timestampExpr(threadCols, 'created_at_ms', 'created_at');
  const col = name => threadCols.has(name) ? name : `NULL AS ${name}`;
  const threadFields = ['id', 'source', 'agent_nickname', 'name', 'title', 'model', 'tokens_used', 'archived'].map(col).join(', ') + `, ${updatedExpr} AS updated_ms, ${createdExpr} AS created_ms`;
  if (availability.state) {
    const sourceAgent = threadCols.has('source') ? "COALESCE((source='subagent' OR source LIKE '%\"subagent\"%'),0)" : '0';
    const agentExpr = has(stateDb, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id']) ? `(${sourceAgent} OR EXISTS(SELECT 1 FROM thread_spawn_edges e WHERE e.child_thread_id=threads.id))` : sourceAgent;
    const archivedExpr = threadCols.has('archived') ? 'archived' : '0';
    const totals = get(stateDb, `SELECT COUNT(*) AS total, SUM(CASE WHEN ${archivedExpr}=1 THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN ${archivedExpr}=0 AND ${agentExpr} THEN 1 ELSE 0 END) AS agents,
      SUM(CASE WHEN ${archivedExpr}=0 AND NOT ${agentExpr} THEN 1 ELSE 0 END) AS main,
      SUM(CASE WHEN ${archivedExpr}=0 AND ${updatedExpr}>=? THEN 1 ELSE 0 END) AS recent FROM threads`, cutoff);
    if (totals) Object.assign(result.sessions, { total: value(totals, 'total'), main: value(totals, 'main') || 0, agents: value(totals, 'agents') || 0, archived: value(totals, 'archived') || 0, recentHour: value(totals, 'recent') || 0 });
    if (threadCols.has('tokens_used')) {
      const tokens = get(stateDb, `SELECT COALESCE(SUM(tokens_used),0) AS total, COALESCE(SUM(CASE WHEN ${archivedExpr}=0 THEN tokens_used ELSE 0 END),0) AS unarchived, COUNT(*) AS n FROM threads`);
      if (tokens) Object.assign(result.tokens, { total: value(tokens, 'total'), unarchived: value(tokens, 'unarchived'), totalThreads: value(tokens, 'n') });
    }
    const recentThreads = query(stateDb, `SELECT ${threadFields} FROM threads WHERE ${updatedExpr}>=? ORDER BY ${updatedExpr} DESC LIMIT ?`, cutoff, MAX_THREADS + 1);
    if (recentThreads.length > MAX_THREADS) Object.assign(result.coverage, { complete: false, recentToolsComplete: false, pendingComplete: false });
    for (const row of recentThreads.slice(0, MAX_THREADS)) candidates.set(row.id, row);
  }
  if (turnsAvailable) {
    const turnCounts = get(historyDb, `SELECT COUNT(*) AS total FROM thread_turns WHERE status='inProgress'`);
    result.turns.totalRunning = value(turnCounts, 'total');
    const turnRows = query(historyDb, `SELECT thread_id, turn_id, status, started_at FROM thread_turns WHERE status='inProgress' ORDER BY started_at DESC LIMIT ?`, MAX_THREADS + 1);
    if (turnRows.length > MAX_THREADS) Object.assign(result.coverage, { complete: false, recentToolsComplete: false, pendingComplete: false });
    for (const row of turnRows.slice(0, MAX_THREADS)) {
      const previous = runningByThread.get(row.thread_id);
      const start = ms(row.started_at);
      const latest = availability.history ? get(historyDb, 'SELECT created_at_ms,completed_at_ms FROM thread_items WHERE thread_id=? AND turn_id=? ORDER BY rollout_ordinal DESC LIMIT 1', row.thread_id, row.turn_id) : null;
      const turnActivityAt = latest ? Math.max(Number(latest.created_at_ms) || 0, Number(latest.completed_at_ms) || 0) : null;
      const stale = (start == null || start < cutoff) && (turnActivityAt == null || turnActivityAt < cutoff);
      stale ? staleRunning++ : recentRunning++;
      if (!previous || (previous.stale && !stale) || (previous.stale === stale && start > previous.startedAt)) runningByThread.set(row.thread_id, { ...row, startedAt: start, stale });
      if (!candidates.has(row.thread_id)) {
        const state = availability.state ? get(stateDb, `SELECT ${threadFields} FROM threads WHERE id=?`, row.thread_id) : null;
        candidates.set(row.thread_id, state || { id: row.thread_id });
      }
    }
    // Also cover completed/failed turns when the state DB is missing or delayed.
    const recent = query(historyDb, `SELECT thread_id, MAX(started_at) AS last_start FROM thread_turns WHERE (CASE WHEN started_at<100000000000 THEN started_at*1000 ELSE started_at END)>=? GROUP BY thread_id ORDER BY last_start DESC LIMIT ?`, cutoff, MAX_THREADS + 1);
    if (recent.length > MAX_THREADS) Object.assign(result.coverage, { complete: false, recentToolsComplete: false, pendingComplete: false });
    for (const row of recent.slice(0, MAX_THREADS)) if (!candidates.has(row.thread_id)) {
      const state = availability.state ? get(stateDb, `SELECT ${threadFields} FROM threads WHERE id=?`, row.thread_id) : null;
      candidates.set(row.thread_id, state || { id: row.thread_id });
    }
  }
  // Active turns take priority if an unusually large workspace exceeds the cap.
  const selected = [...candidates.values()].sort((a, b) => Number(runningByThread.has(b.id)) - Number(runningByThread.has(a.id)) || (b.updated_ms || 0) - (a.updated_ms || 0));
  if (selected.length > MAX_THREADS) Object.assign(result.coverage, { complete: false, recentToolsComplete: false, pendingComplete: false });
  const durationRows = [];
  const byType = new Map();
  let pendingCount = 0, stalePending = 0;
  const sessionRows = [];
  for (const thread of selected.slice(0, MAX_THREADS)) {
    result.coverage.threads++;
    let lastActivityAt = Number(thread.updated_ms) || null;
    let toolsPending = 0;
    const info = sourceInfo(thread.source);
    if (!info.parentId && has(stateDb, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])) {
      const edge = get(stateDb, 'SELECT parent_thread_id FROM thread_spawn_edges WHERE child_thread_id=?', thread.id);
      if (edge) Object.assign(info, { parentId: edge.parent_thread_id, isAgent: true, depth: Math.max(1, info.depth) });
    }
    if (availability.history) {
      const newest = get(historyDb, 'SELECT created_at_ms, completed_at_ms FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1', thread.id);
      if (newest) lastActivityAt = Math.max(lastActivityAt || 0, Number(newest.created_at_ms) || 0, Number(newest.completed_at_ms) || 0) || null;
      const boundary = get(historyDb, 'SELECT created_at_ms FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1 OFFSET ?', thread.id, MAX_ITEMS_PER_THREAD);
      if (boundary) {
        result.coverage.cappedThreads++;
        result.coverage.complete = false;
        result.coverage.pendingComplete = false;
        // An old ordinal can finish late. Its creation timestamp alone cannot
        // prove all recent completions are inside this bounded window.
        result.coverage.recentToolsComplete = false;
      }
      const items = query(historyDb, `SELECT bounded.item_id, bounded.item_type, bounded.created_at_ms, bounded.started_at_ms, bounded.completed_at_ms,
        CASE WHEN json_valid(item_json) THEN json_extract(item_json,'$.status') END AS tool_status,
        CASE WHEN json_valid(item_json) THEN json_extract(item_json,'$.exitCode') END AS exit_code,
        CASE WHEN json_valid(item_json) THEN CASE WHEN json_type(item_json,'$.error') IN ('text','object','array') THEN 1 ELSE 0 END END AS has_error,
        CASE WHEN json_valid(item_json) AND json_type(item_json,'$.durationMs') IN ('integer','real') THEN json_extract(item_json,'$.durationMs') END AS reported_duration
        FROM (SELECT rowid AS payload_rowid,item_id,item_type,created_at_ms,started_at_ms,completed_at_ms FROM thread_items WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT ?) AS bounded
        JOIN thread_items AS payload ON payload.rowid=bounded.payload_rowid
        WHERE bounded.item_type IN ${TOOL_SQL} AND (bounded.created_at_ms>=? OR bounded.completed_at_ms>=? OR bounded.completed_at_ms IS NULL)`, thread.id, MAX_ITEMS_PER_THREAD, cutoff, cutoff);
      for (const item of items) {
        const outcome = toolOutcome(item);
        const at = Number(item.created_at_ms);
        const completionAt = Number(item.completed_at_ms);
        if ((outcome === 'completed' || outcome === 'failed') && item.completed_at_ms != null && completionAt >= cutoff && completionAt <= now) {
          const key = outcome === 'failed' ? 'failedDuring' : 'completedDuring';
          result.tools.window1h[key]++;
          if (completionAt >= now - TEN_MINUTES) result.tools.window10m[key]++;
        }
        if (at >= cutoff && at <= now) {
          addOutcome(result.tools.window1h, outcome);
          if (at >= now - TEN_MINUTES) addOutcome(result.tools.window10m, outcome);
          if (!byType.has(item.item_type)) byType.set(item.item_type, { type: item.item_type, ...blankWindow() });
          addOutcome(byType.get(item.item_type), outcome);
          const duration = outcome === 'completed' || outcome === 'failed' ? toolDuration(item) : null;
          if (duration != null) durationRows.push({ at, duration });
        }
        if (outcome === 'pending') {
          const startedAt = item.started_at_ms ?? item.created_at_ms;
          if (at >= cutoff && at <= now) { pendingCount++; toolsPending++; }
          else if (at < cutoff) stalePending++;
          if (at <= now) result.tools.pendingRows.push({ threadId: thread.id, itemId: item.item_id, type: item.item_type, startedAt, waitMs: age(now, startedAt), stale: at < cutoff });
        }
      }
    }
    const turn = runningByThread.get(thread.id);
    const running = !!turn;
    const stale = running && turn.stale;
    sessionRows.push({
      id: thread.id, label: clean(thread.agent_nickname || thread.name || thread.title || String(thread.id).slice(0, 8)),
      parentId: info.parentId, depth: info.depth, isAgent: info.isAgent, model: clean(thread.model || '', 60),
      lastActivityAt, turnStartedAt: turn?.startedAt ?? null, runningMs: running ? age(now, turn.startedAt) : null,
      status: stale ? 'stale' : running ? 'inProgress' : 'recent', stale, archived: !!thread.archived,
      toolsPending, tokensUsed: thread.tokens_used == null ? null : Number(thread.tokens_used),
    });
  }
  if (result.turns.totalRunning != null) Object.assign(result.turns, { recentRunning, staleRunning });
  if (availability.history) Object.assign(result.tools, { pending: pendingCount, stalePending, completed10m: result.tools.window10m.completedDuring + result.tools.window10m.failedDuring, success10m: result.tools.window10m.completedDuring, failed10m: result.tools.window10m.failedDuring });
  result.tools.pendingRows.sort((a, b) => Number(a.stale) - Number(b.stale) || b.waitMs - a.waitMs);
  result.tools.oldestPendingMs = result.tools.pendingRows.find(row => !row.stale)?.waitMs ?? null;
  result.tools.pendingRows = result.tools.pendingRows.slice(0, limit);
  result.tools.byType = [...byType.values()].sort((a, b) => b.total - a.total);
  durationRows.sort((a, b) => b.at - a.at);
  const durations = durationRows.slice(0, MAX_DURATION_SAMPLES).map(row => row.duration).sort((a, b) => a - b);
  result.tools.durationSampleCount = durations.length;
  result.tools.p50Ms = quantile(durations, 0.5);
  result.tools.p95Ms = quantile(durations, 0.95);
  result.sessions.rows = sessionRows.sort((a, b) => (a.status === 'inProgress' ? 0 : a.stale ? 2 : 1) - (b.status === 'inProgress' ? 0 : b.stale ? 2 : 1) || (b.lastActivityAt || 0) - (a.lastActivityAt || 0)).slice(0, limit);

  if (availability.logs) {
    const levels = query(logsDb, "SELECT level, COUNT(*) AS n FROM logs WHERE ts>=? AND ts<=? AND level IN ('ERROR','WARN') GROUP BY level", Math.ceil((now - TEN_MINUTES) / 1000), Math.floor(now / 1000));
    result.alerts.error10m = Number(levels.find(row => row.level === 'ERROR')?.n || 0);
    result.alerts.warn10m = Number(levels.find(row => row.level === 'WARN')?.n || 0);
    result.alerts.errorPerMinute = result.alerts.error10m / 10;
    result.alerts.warnPerMinute = result.alerts.warn10m / 10;
    // Summarize only logger targets. Bodies can contain commands or credentials.
    const recent = query(logsDb, "SELECT level, target, MAX(ts) AS at, COUNT(*) AS n FROM logs WHERE ts>=? AND ts<=? AND level IN ('ERROR','WARN') GROUP BY level,target ORDER BY at DESC LIMIT ?", Math.ceil((now - TEN_MINUTES) / 1000), Math.floor(now / 1000), limit);
    result.alerts.recent = recent.map(row => ({ level: row.level, target: clean(row.target, 90), at: Number(row.at) * 1000, count: Number(row.n) }));
  }
  if (availability.queue) {
    const queued = get(queueDb, 'SELECT COUNT(*) AS n, MIN(created_at_ms) AS oldest FROM queued_items');
    if (queued) Object.assign(result.queue, { count: value(queued, 'n'), oldestWaitMs: queued.oldest == null ? null : age(now, Number(queued.oldest)) });
  }
  if (availability.goals) {
    const states = query(goalsDb, 'SELECT status, COUNT(*) AS n FROM thread_goals GROUP BY status');
    result.goals.byStatus = Object.fromEntries(states.map(row => [row.status, Number(row.n)]));
    result.goals.total = states.reduce((sum, row) => sum + Number(row.n), 0);
    result.goals.active = result.goals.byStatus.active || 0;
  }
  // An empty successful query establishes a zero. A failed query establishes
  // no observation, even if an earlier query against the same source succeeded.
  for (const source of queryFailures) availability[source] = false;
  if (queryFailures.has('history')) result.coverage.turnsAvailable = false;
  result.coverage.failedSources = [...queryFailures];
  result.coverage.unavailableSources = Object.keys(availability).filter(source => !availability[source]);
  if (result.coverage.unavailableSources.length) result.coverage.complete = false;
  if (!availability.history || !availability.state || queryFailures.has('state')) {
    result.coverage.recentToolsComplete = false;
    result.coverage.pendingComplete = false;
  }
  if (!availability.history || queryFailures.has('state')) {
    Object.assign(result.tools, {
      window10m: unavailableWindow(), window1h: unavailableWindow(), byType: [],
      pending: null, stalePending: null, pendingRows: [], oldestPendingMs: null,
      completed10m: null, success10m: null, failed10m: null,
      durationSampleCount: null, p50Ms: null, p95Ms: null,
    });
  }
  if (!availability.history) {
    result.turns = { recentRunning: null, staleRunning: null, totalRunning: null };
    result.sessions.rows = result.sessions.rows.map(row => ({ ...row, status: 'unknown', stale: null, turnStartedAt: null, runningMs: null, toolsPending: null }));
  }
  if (!availability.state) {
    Object.assign(result.sessions, { total: null, main: null, agents: null, archived: null, recentHour: null });
    result.tokens = { total: null, unarchived: null, totalThreads: null, monitorDelta: null, monitorSince: null, resetDetected: false };
    if (queryFailures.has('state')) result.sessions.rows = [];
  }
  if (!availability.logs) result.alerts = { error10m: null, warn10m: null, errorPerMinute: null, warnPerMinute: null, recent: [] };
  if (!availability.queue) result.queue = { count: null, oldestWaitMs: null };
  if (!availability.goals) result.goals = { total: null, active: null, byStatus: {} };
  return result;
}

/** Cached collector with a token baseline stable across thread archival. */
export function createActivityCollector({ cacheMs = 5_000 } = {}) {
  cacheMs = Math.max(5_000, Number(cacheMs) || 5_000);
  let cached = null, cachedAt = null, baseline = null, baselineAt = null, lastTotal = null, resetDetected = false;
  let handles = null;
  return function collect(options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const nextHandles = [options.historyDb, options.stateDb, options.logsDb, options.queueDb, options.goalsDb];
    const sameHandles = handles && nextHandles.every((handle, i) => handle === handles[i]);
    if (sameHandles && cached && now >= cachedAt && now - cachedAt < cacheMs) return cached;
    handles = nextHandles;
    const snapshot = collectActivity({ ...options, now });
    if (snapshot.tokens.total != null) {
      if (baseline == null) { baseline = snapshot.tokens.total; baselineAt = now; }
      if (lastTotal != null && snapshot.tokens.total < lastTotal) resetDetected = true;
      lastTotal = snapshot.tokens.total;
      Object.assign(snapshot.tokens, { monitorSince: baselineAt, monitorDelta: resetDetected ? null : Math.max(0, snapshot.tokens.total - baseline), resetDetected });
    }
    cached = snapshot;
    cachedAt = now;
    return snapshot;
  };
}
