// ============ SQLITE PERSISTENCE ============
// Uses a single SQLite file on the Render persistent disk.
// Tables:
//   - alerts: history of alerts triggered
//   - settings: key-value store for watchlists & user prefs (replicated across devices)

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = process.env.DB_PATH || '/var/data/reversal.db';

// Ensure dir exists (Render mounts persistent disk at /var/data by default)
try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch {}

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  console.log(`SQLite opened: ${DB_PATH}`);
} catch (e) {
  console.error(`Failed to open ${DB_PATH}, falling back to in-memory:`, e.message);
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    decision TEXT NOT NULL,
    posterior REAL NOT NULL,
    current_price REAL,
    reason TEXT,
    market_state TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  );
`);

// ---- Alerts API ----
const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (timestamp, symbol, decision, posterior, current_price, reason, market_state)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const listAlertsStmt = db.prepare(`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`);
const deleteOldAlertsStmt = db.prepare(`DELETE FROM alerts WHERE timestamp < ?`);
const clearAlertsStmt = db.prepare(`DELETE FROM alerts`);

export const alertsDB = {
  insert(alert) {
    return insertAlertStmt.run(
      alert.timestamp || Date.now(),
      alert.symbol,
      alert.decision,
      alert.posterior,
      alert.currentPrice ?? null,
      alert.reason ?? null,
      alert.marketState ?? null,
    );
  },
  list(limit = 200) {
    return listAlertsStmt.all(limit);
  },
  pruneOlderThan(ms) {
    return deleteOldAlertsStmt.run(Date.now() - ms);
  },
  clear() {
    return clearAlertsStmt.run();
  },
};

// ---- Settings (key-value JSON) ----
const getSettingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%s', 'now') * 1000)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

export const settingsDB = {
  get(key) {
    const row = getSettingStmt.get(key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  },
  set(key, value) {
    return setSettingStmt.run(key, JSON.stringify(value));
  },
};

// Auto-prune alerts older than 30 days, hourly
setInterval(() => {
  try {
    const result = alertsDB.pruneOlderThan(30 * 24 * 60 * 60 * 1000);
    if (result.changes > 0) console.log(`Pruned ${result.changes} old alerts`);
  } catch (e) { console.error('Prune failed:', e.message); }
}, 60 * 60 * 1000);

export default db;
