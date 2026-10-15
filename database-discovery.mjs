import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// A failed or concurrently replaced candidate must not hide another usable file.
// Ownership of only the selected read-only connection passes to the caller.
export function discoverDatabase({ home, prefix, table }) {
  let names;
  try { names = fs.readdirSync(home); } catch { return null; }
  const candidates = [];
  for (const file of names) {
    if (!file.startsWith(prefix) || !file.endsWith('.sqlite')) continue;
    try {
      const stat = fs.statSync(path.join(home, file));
      if (stat.isFile()) candidates.push({ file, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { file } of candidates) {
    let db, selected = false;
    try {
      db = new DatabaseSync(path.join(home, file), { readOnly: true });
      const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (hit) { selected = true; return { db, file }; }
    } catch {
      // Corruption, locking and unsupported schemas make this source unavailable.
    } finally {
      if (db && !selected) { try { db.close(); } catch {} }
    }
  }
  return null;
}
