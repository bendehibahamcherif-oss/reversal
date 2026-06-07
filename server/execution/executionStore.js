import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDataDir } from '../utils/storagePaths.js';

const DB_PATH  = path.join(DATA_DIR, 'reversal.db');

let _db = null;

function db() {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS execution_orders (
      orderId         TEXT PRIMARY KEY,
      clientOrderId   TEXT UNIQUE,
      symbol          TEXT NOT NULL,
      side            TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'market',
      quantity        REAL NOT NULL,
      requestedPrice  REAL,
      status          TEXT NOT NULL DEFAULT 'submitted',
      fillPrice       REAL,
      fillQuantity    REAL,
      avgFillPrice    REAL,
      commissions     REAL DEFAULT 0,
      slippageBps     REAL DEFAULT 0,
      arrivalPrice    REAL,
      rejectionReason TEXT,
      mode            TEXT NOT NULL DEFAULT 'paper',
      source          TEXT NOT NULL DEFAULT 'paper_engine',
      strategyId      TEXT,
      brokerOrderId   TEXT,
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_orders_symbol ON execution_orders(symbol);
    CREATE INDEX IF NOT EXISTS idx_exec_orders_status ON execution_orders(status);
    CREATE INDEX IF NOT EXISTS idx_exec_orders_created ON execution_orders(createdAt);
    CREATE INDEX IF NOT EXISTS idx_exec_orders_client ON execution_orders(clientOrderId);

    CREATE TABLE IF NOT EXISTS execution_fills (
      fillId          TEXT PRIMARY KEY,
      orderId         TEXT NOT NULL REFERENCES execution_orders(orderId),
      clientOrderId   TEXT,
      symbol          TEXT NOT NULL,
      side            TEXT NOT NULL,
      quantity        REAL NOT NULL,
      price           REAL NOT NULL,
      commissions     REAL DEFAULT 0,
      slippageBps     REAL DEFAULT 0,
      mode            TEXT DEFAULT 'paper',
      executedAt      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_exec_fills_order ON execution_fills(orderId);
    CREATE INDEX IF NOT EXISTS idx_exec_fills_symbol ON execution_fills(symbol);
  `);
  return _db;
}

export const executionStore = {
  // ── Orders ──────────────────────────────────────────────────────────────────

  saveOrder(order) {
    db().prepare(`
      INSERT OR REPLACE INTO execution_orders
        (orderId, clientOrderId, symbol, side, type, quantity, requestedPrice,
         status, fillPrice, fillQuantity, avgFillPrice, commissions, slippageBps,
         arrivalPrice, rejectionReason, mode, source, strategyId, brokerOrderId,
         createdAt, updatedAt)
      VALUES
        (@orderId, @clientOrderId, @symbol, @side, @type, @quantity, @requestedPrice,
         @status, @fillPrice, @fillQuantity, @avgFillPrice, @commissions, @slippageBps,
         @arrivalPrice, @rejectionReason, @mode, @source, @strategyId, @brokerOrderId,
         @createdAt, @updatedAt)
    `).run(order);
    return order;
  },

  updateOrderStatus(orderId, patch) {
    const fields = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
    db().prepare(`UPDATE execution_orders SET ${fields}, updatedAt = @updatedAt WHERE orderId = @orderId`)
      .run({ ...patch, updatedAt: new Date().toISOString(), orderId });
  },

  getOrderByClientId(clientOrderId) {
    return db().prepare('SELECT * FROM execution_orders WHERE clientOrderId = ?').get(clientOrderId) || null;
  },

  getOrderById(orderId) {
    return db().prepare('SELECT * FROM execution_orders WHERE orderId = ?').get(orderId) || null;
  },

  getOrders({ symbol, mode, status, limit = 100 } = {}) {
    let sql = 'SELECT * FROM execution_orders WHERE 1=1';
    const params = [];
    if (symbol) { sql += ' AND symbol = ?'; params.push(String(symbol).toUpperCase()); }
    if (mode)   { sql += ' AND mode = ?';   params.push(mode); }
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY createdAt DESC LIMIT ?';
    params.push(Math.min(500, Number(limit) || 100));
    return db().prepare(sql).all(...params);
  },

  // ── Fills ───────────────────────────────────────────────────────────────────

  saveFill(fill) {
    db().prepare(`
      INSERT OR REPLACE INTO execution_fills
        (fillId, orderId, clientOrderId, symbol, side, quantity, price, commissions, slippageBps, mode, executedAt)
      VALUES
        (@fillId, @orderId, @clientOrderId, @symbol, @side, @quantity, @price, @commissions, @slippageBps, @mode, @executedAt)
    `).run(fill);
    return fill;
  },

  getFills({ symbol, mode, limit = 100 } = {}) {
    let sql = 'SELECT * FROM execution_fills WHERE 1=1';
    const params = [];
    if (symbol) { sql += ' AND symbol = ?'; params.push(String(symbol).toUpperCase()); }
    if (mode)   { sql += ' AND mode = ?';   params.push(mode); }
    sql += ' ORDER BY executedAt DESC LIMIT ?';
    params.push(Math.min(500, Number(limit) || 100));
    return db().prepare(sql).all(...params);
  },
};
