import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/var/data';
const DB_PATH  = path.join(DATA_DIR, 'reversal.db');

let _db = null;

function db() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    -- ── Canonical OMS order table ──────────────────────────────────────────────
    -- Single row per order (current state). All history in oms_events.
    CREATE TABLE IF NOT EXISTS oms_orders (
      orderId          TEXT PRIMARY KEY,
      clientOrderId    TEXT UNIQUE NOT NULL,
      parentOrderId    TEXT,
      brokerOrderId    TEXT,
      symbol           TEXT NOT NULL,
      side             TEXT NOT NULL,
      type             TEXT NOT NULL DEFAULT 'market',
      quantity         REAL NOT NULL,
      requestedPrice   REAL,
      stopPrice        REAL,
      tif              TEXT NOT NULL DEFAULT 'day',
      status           TEXT NOT NULL DEFAULT 'pending',
      filledQuantity   REAL NOT NULL DEFAULT 0,
      leavesQuantity   REAL NOT NULL DEFAULT 0,
      avgFillPrice     REAL,
      commissions      REAL NOT NULL DEFAULT 0,
      slippageBps      REAL NOT NULL DEFAULT 0,
      rejectionReason  TEXT,
      mode             TEXT NOT NULL DEFAULT 'paper',
      source           TEXT NOT NULL DEFAULT 'oms',
      strategyId       TEXT,
      createdAt        TEXT NOT NULL,
      updatedAt        TEXT NOT NULL,
      submittedAt      TEXT,
      acknowledgedAt   TEXT,
      firstFillAt      TEXT,
      completedAt      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oms_orders_client    ON oms_orders(clientOrderId);
    CREATE INDEX IF NOT EXISTS idx_oms_orders_broker    ON oms_orders(brokerOrderId);
    CREATE INDEX IF NOT EXISTS idx_oms_orders_symbol    ON oms_orders(symbol);
    CREATE INDEX IF NOT EXISTS idx_oms_orders_status    ON oms_orders(status);
    CREATE INDEX IF NOT EXISTS idx_oms_orders_parent    ON oms_orders(parentOrderId);
    CREATE INDEX IF NOT EXISTS idx_oms_orders_created   ON oms_orders(createdAt);

    -- ── Append-only event journal ──────────────────────────────────────────────
    -- Every state transition appends a row. Never updated after insert.
    CREATE TABLE IF NOT EXISTS oms_events (
      eventId              TEXT PRIMARY KEY,
      orderId              TEXT NOT NULL REFERENCES oms_orders(orderId),
      clientOrderId        TEXT,
      brokerOrderId        TEXT,
      eventType            TEXT NOT NULL,
      fromStatus           TEXT,
      toStatus             TEXT NOT NULL,
      fillQuantity         REAL,
      fillPrice            REAL,
      cumulativeFilledQty  REAL,
      leavesQty            REAL,
      commissions          REAL,
      rejectionReason      TEXT,
      brokerTimestamp      TEXT,
      payload              TEXT,
      recordedAt           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oms_events_order   ON oms_events(orderId);
    CREATE INDEX IF NOT EXISTS idx_oms_events_client  ON oms_events(clientOrderId);
    CREATE INDEX IF NOT EXISTS idx_oms_events_type    ON oms_events(eventType);
    CREATE INDEX IF NOT EXISTS idx_oms_events_time    ON oms_events(recordedAt);

    -- ── Reconciliation run history ──────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS oms_reconciliation_runs (
      runId          TEXT PRIMARY KEY,
      ranAt          TEXT NOT NULL,
      mode           TEXT NOT NULL,
      ordersChecked  INTEGER NOT NULL DEFAULT 0,
      divergences    INTEGER NOT NULL DEFAULT 0,
      corrections    INTEGER NOT NULL DEFAULT 0,
      details        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oms_recon_time ON oms_reconciliation_runs(ranAt);
  `);
  return _db;
}

export const omsStore = {
  // ── Orders ──────────────────────────────────────────────────────────────────

  upsertOrder(order) {
    db().prepare(`
      INSERT OR REPLACE INTO oms_orders
        (orderId, clientOrderId, parentOrderId, brokerOrderId, symbol, side, type,
         quantity, requestedPrice, stopPrice, tif, status, filledQuantity,
         leavesQuantity, avgFillPrice, commissions, slippageBps, rejectionReason,
         mode, source, strategyId, createdAt, updatedAt, submittedAt,
         acknowledgedAt, firstFillAt, completedAt)
      VALUES
        (@orderId, @clientOrderId, @parentOrderId, @brokerOrderId, @symbol, @side, @type,
         @quantity, @requestedPrice, @stopPrice, @tif, @status, @filledQuantity,
         @leavesQuantity, @avgFillPrice, @commissions, @slippageBps, @rejectionReason,
         @mode, @source, @strategyId, @createdAt, @updatedAt, @submittedAt,
         @acknowledgedAt, @firstFillAt, @completedAt)
    `).run(order);
    return order;
  },

  patchOrder(orderId, fields) {
    const now  = new Date().toISOString();
    const keys = Object.keys(fields);
    const set  = [...keys.map((k) => `${k} = @${k}`), 'updatedAt = @updatedAt'].join(', ');
    db().prepare(`UPDATE oms_orders SET ${set} WHERE orderId = @orderId`)
      .run({ ...fields, updatedAt: now, orderId });
  },

  getOrderById(orderId) {
    return db().prepare('SELECT * FROM oms_orders WHERE orderId = ?').get(orderId) || null;
  },

  getOrderByClientId(clientOrderId) {
    return db().prepare('SELECT * FROM oms_orders WHERE clientOrderId = ?').get(clientOrderId) || null;
  },

  getOrderByBrokerId(brokerOrderId) {
    return db().prepare('SELECT * FROM oms_orders WHERE brokerOrderId = ?').get(brokerOrderId) || null;
  },

  getOrders({ symbol, mode, status, parentOrderId, limit = 100 } = {}) {
    const conditions = ['1=1'];
    const params     = [];
    if (symbol)        { conditions.push('symbol = ?');        params.push(String(symbol).toUpperCase()); }
    if (mode)          { conditions.push('mode = ?');           params.push(mode); }
    if (status)        { conditions.push('status = ?');         params.push(status); }
    if (parentOrderId) { conditions.push('parentOrderId = ?');  params.push(parentOrderId); }
    params.push(Math.min(1000, Number(limit) || 100));
    return db().prepare(`SELECT * FROM oms_orders WHERE ${conditions.join(' AND ')} ORDER BY createdAt DESC LIMIT ?`).all(...params);
  },

  getOpenOrders(mode) {
    const OPEN_STATUSES = "'pending','submitted','acknowledged','partially_filled'";
    const sql = mode
      ? `SELECT * FROM oms_orders WHERE status IN (${OPEN_STATUSES}) AND mode = ?`
      : `SELECT * FROM oms_orders WHERE status IN (${OPEN_STATUSES})`;
    return mode ? db().prepare(sql).all(mode) : db().prepare(sql).all();
  },

  getChildren(parentOrderId) {
    return db().prepare('SELECT * FROM oms_orders WHERE parentOrderId = ?').all(parentOrderId);
  },

  // ── Events ──────────────────────────────────────────────────────────────────

  appendEvent(event) {
    db().prepare(`
      INSERT INTO oms_events
        (eventId, orderId, clientOrderId, brokerOrderId, eventType, fromStatus,
         toStatus, fillQuantity, fillPrice, cumulativeFilledQty, leavesQty,
         commissions, rejectionReason, brokerTimestamp, payload, recordedAt)
      VALUES
        (@eventId, @orderId, @clientOrderId, @brokerOrderId, @eventType, @fromStatus,
         @toStatus, @fillQuantity, @fillPrice, @cumulativeFilledQty, @leavesQty,
         @commissions, @rejectionReason, @brokerTimestamp, @payload, @recordedAt)
    `).run(event);
    return event;
  },

  getEvents(orderId) {
    return db().prepare('SELECT * FROM oms_events WHERE orderId = ? ORDER BY recordedAt ASC').all(orderId);
  },

  getRecentEvents(limit = 50) {
    return db().prepare('SELECT * FROM oms_events ORDER BY recordedAt DESC LIMIT ?').all(Math.min(500, limit));
  },

  // ── Reconciliation runs ──────────────────────────────────────────────────────

  saveReconciliationRun(run) {
    db().prepare(`
      INSERT OR REPLACE INTO oms_reconciliation_runs
        (runId, ranAt, mode, ordersChecked, divergences, corrections, details)
      VALUES (@runId, @ranAt, @mode, @ordersChecked, @divergences, @corrections, @details)
    `).run({ ...run, details: JSON.stringify(run.details || []) });
    return run;
  },

  getReconciliationRuns(limit = 20) {
    return db().prepare('SELECT * FROM oms_reconciliation_runs ORDER BY ranAt DESC LIMIT ?')
      .all(limit)
      .map((r) => ({ ...r, details: JSON.parse(r.details || '[]') }));
  },
};
