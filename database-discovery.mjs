import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

function candidatesIn(home, prefixes) {
  let names;
  try { names = fs.readdirSync(home); } catch { return []; }
  const candidates = [];
  for (const file of names) {
    if (!file.endsWith('.sqlite') || !prefixes.some(prefix => file.startsWith(prefix))) continue;
    try {
      const filename = path.join(home, file);
      const stat = fs.statSync(filename, { bigint: true });
      if (stat.isFile()) candidates.push({ filename, file, dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs });
    } catch {}
  }
  return candidates.sort((a, b) => a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1);
}

function sameFile(a, b) {
  return a?.file === b?.file && a?.dev === b?.dev && a?.ino === b?.ino;
}

// Looking at the file header catches in-place truncation/overwrites even when a
// long-lived SQLite connection still has the old schema pages in its cache.
function hasCurrentHeader(candidate) {
  let fd;
  try {
    fd = fs.openSync(candidate.filename, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.dev !== candidate.dev || stat.ino !== candidate.ino) return false;
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(SQLITE_HEADER);
  } catch { return false; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

function hasTable(db, table) {
  const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!hit) return false;
  // Read at most one row: this also checks that the table's root page remains
  // readable, without scanning the history/log tables on every refresh.
  db.prepare(`SELECT 1 FROM "${table.replaceAll('"', '""')}" LIMIT 1`).get();
  return true;
}

function closeDatabase(db) {
  try { db?.close(); } catch {}
}

function selectDatabase(candidates, table, previous) {
  for (const candidate of candidates) {
    if (previous && sameFile(candidate, previous.candidate)) {
      if (!hasCurrentHeader(candidate)) continue;
      try {
        if (hasTable(previous.source.db, table)) return { ...previous, candidate };
      } catch {}
    }
    let db, selected = false;
    try {
      db = new DatabaseSync(candidate.filename, { readOnly: true });
      if (!hasTable(db, table)) continue;
      // Do not retain a connection discovered during a concurrent file swap.
      const stat = fs.statSync(candidate.filename, { bigint: true });
      if (stat.dev !== candidate.dev || stat.ino !== candidate.ino) continue;
      selected = true;
      return { candidate, source: { db, file: candidate.file } };
    } catch {
      // Corruption, locking and unsupported schemas make this source unavailable.
    } finally {
      if (db && !selected) closeDatabase(db);
    }
  }
  return null;
}

// A failed or concurrently replaced candidate must not hide another usable file.
// Ownership of only the selected read-only connection passes to the caller.
export function discoverDatabase({ home, prefix, table }) {
  return selectDatabase(candidatesIn(home, [prefix]), table, null)?.source ?? null;
}

// A watch session can outlive a Codex schema upgrade or start before its data
// directory exists. Refresh all sources together, reusing valid connections by
// file identity rather than mtime (which changes during ordinary database writes).
export function createDatabaseRegistry({ home, sources, intervalMs = 5000, now = Date.now }) {
  const configs = Object.entries(sources);
  const prefixes = [...new Set(configs.map(([, { prefix }]) => prefix))];
  let selected = new Map();
  let snapshot = Object.fromEntries(configs.map(([key]) => [key, null]));
  let refreshedAt = null;
  let closed = false;
  return {
    refresh({ force = false } = {}) {
      if (closed) return snapshot;
      const time = now();
      // A wall-clock correction must not postpone discovery until time catches up.
      if (!force && refreshedAt !== null && time >= refreshedAt && time - refreshedAt < intervalMs) return snapshot;
      refreshedAt = time;
      const candidates = candidatesIn(home, prefixes);
      const nextSelected = new Map();
      const nextSnapshot = {};
      for (const [key, { prefix, table }] of configs) {
        const previous = selected.get(key);
        const next = selectDatabase(candidates.filter(candidate => candidate.file.startsWith(prefix)), table, previous);
        if (next) nextSelected.set(key, next);
        nextSnapshot[key] = next?.source ?? null;
        // Keep the old handle alive until its replacement is validated.
        if (previous?.source !== next?.source) closeDatabase(previous?.source.db);
      }
      selected = nextSelected;
      snapshot = nextSnapshot;
      return snapshot;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const { source } of selected.values()) closeDatabase(source.db);
      selected.clear();
      snapshot = Object.fromEntries(configs.map(([key]) => [key, null]));
    },
  };
}
