// ============ SQLITE PERSISTENCE ============
// Uses a single SQLite file on the Render persistent disk.
// Tables:
//   - alerts: history of alerts triggered
//   - settings: key-value store for watchlists & user prefs
//   - users: JWT login users
//   - password_resets: one-time password reset tokens

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const DB_PATH = process.env.DB_PATH || '/var/data/reversal.db';

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

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);
`);

const insertAlertStmt = db.prepare(`
  INSERT INTO alerts (timestamp, symbol, decision, posterior, current_price, reason, market_state)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const listAlertsStmt = db.prepare(`SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?`);
const deleteOldAlertsStmt = db.prepare(`DELETE FROM alerts WHERE timestamp < ?`);
const clearAlertsStmt = db.prepare(`DELETE FROM alerts`);

export const alertsDB = {
  insert(alert) {
    return insertAlertStmt.run(alert.timestamp || Date.now(), alert.symbol, alert.decision, alert.posterior, alert.currentPrice ?? null, alert.reason ?? null, alert.marketState ?? null);
  },
  list(limit = 200) { return listAlertsStmt.all(limit); },
  pruneOlderThan(ms) { return deleteOldAlertsStmt.run(Date.now() - ms); },
  clear() { return clearAlertsStmt.run(); },
};

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
  set(key, value) { return setSettingStmt.run(key, JSON.stringify(value)); },
};

const getUserByEmailStmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
const getUserByIdStmt = db.prepare(`SELECT id, email, role, created_at FROM users WHERE id = ?`);
const listUsersStmt = db.prepare(`SELECT id, email, role, created_at FROM users ORDER BY created_at DESC LIMIT ?`);
const createUserStmt = db.prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`);
const updatePasswordStmt = db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`);

export const usersDB = {
  create({ email, passwordHash, role = 'admin' }) {
    const result = createUserStmt.run(email.toLowerCase(), passwordHash, role);
    return getUserByIdStmt.get(result.lastInsertRowid);
  },
  getByEmail(email) { return getUserByEmailStmt.get(String(email).toLowerCase()); },
  getById(id) { return getUserByIdStmt.get(id); },
  list(limit = 200) { return listUsersStmt.all(limit); },
  updatePassword(id, passwordHash) { return updatePasswordStmt.run(passwordHash, id); },
};

const createPasswordResetStmt = db.prepare(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`);
const getPasswordResetStmt = db.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`);
const markPasswordResetUsedStmt = db.prepare(`UPDATE password_resets SET used_at = ? WHERE id = ?`);
const prunePasswordResetsStmt = db.prepare(`DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL`);

export const passwordResetsDB = {
  create({ userId, tokenHash, expiresAt }) { return createPasswordResetStmt.run(userId, tokenHash, expiresAt); },
  getValid(tokenHash) { return getPasswordResetStmt.get(tokenHash, Date.now()); },
  markUsed(id) { return markPasswordResetUsedStmt.run(Date.now(), id); },
  prune() { return prunePasswordResetsStmt.run(Date.now()); },
};

setInterval(() => {
  try {
    const result = alertsDB.pruneOlderThan(30 * 24 * 60 * 60 * 1000);
    passwordResetsDB.prune();
    if (result.changes > 0) console.log(`Pruned ${result.changes} old alerts`);
  } catch (e) { console.error('Prune failed:', e.message); }
}, 60 * 60 * 1000);

export default db;
