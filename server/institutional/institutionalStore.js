import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDataDir } from '../utils/storagePaths.js';

const DB_PATH  = path.join(DATA_DIR, 'institutional.db');

let _db = null;

function db() {
  if (_db) return _db;
  ensureDataDir();
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    -- ── Immutable audit log ───────────────────────────────────────────────────
    -- Every analysis run (sizing, scenario, export) appends one row.
    -- Rows are never updated after insert (append-only).
    CREATE TABLE IF NOT EXISTS institutional_audit (
      auditId        TEXT PRIMARY KEY,
      timestamp      TEXT NOT NULL,
      analysisType   TEXT NOT NULL,
      mode           TEXT NOT NULL DEFAULT 'paper',
      inputs         TEXT NOT NULL,
      outputs        TEXT NOT NULL,
      mlSignalUsed   INTEGER NOT NULL DEFAULT 0,
      mlSignalId     TEXT,
      mlConfidence   REAL,
      notes          TEXT,
      engineVersion  TEXT NOT NULL DEFAULT '1.0'
    );
    CREATE INDEX IF NOT EXISTS idx_inst_audit_time ON institutional_audit(timestamp);
    CREATE INDEX IF NOT EXISTS idx_inst_audit_type ON institutional_audit(analysisType);
    CREATE INDEX IF NOT EXISTS idx_inst_audit_mode ON institutional_audit(mode);

    -- ── Persisted scenario results ────────────────────────────────────────────
    -- Scenarios are stored separately so they can be referenced in reports.
    CREATE TABLE IF NOT EXISTS institutional_scenarios (
      scenarioId   TEXT PRIMARY KEY,
      auditId      TEXT NOT NULL REFERENCES institutional_audit(auditId),
      name         TEXT NOT NULL,
      packId       TEXT,
      mode         TEXT NOT NULL DEFAULT 'paper',
      inputs       TEXT NOT NULL,
      results      TEXT NOT NULL,
      createdAt    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inst_scen_audit ON institutional_scenarios(auditId);
    CREATE INDEX IF NOT EXISTS idx_inst_scen_time  ON institutional_scenarios(createdAt);
  `);
  return _db;
}

export const institutionalStore = {

  // ── Audit ──────────────────────────────────────────────────────────────────

  appendAudit(entry) {
    db().prepare(`
      INSERT INTO institutional_audit
        (auditId, timestamp, analysisType, mode, inputs, outputs,
         mlSignalUsed, mlSignalId, mlConfidence, notes, engineVersion)
      VALUES
        (@auditId, @timestamp, @analysisType, @mode, @inputs, @outputs,
         @mlSignalUsed, @mlSignalId, @mlConfidence, @notes, @engineVersion)
    `).run({
      ...entry,
      inputs:  JSON.stringify(entry.inputs),
      outputs: JSON.stringify(entry.outputs),
      mlSignalUsed: entry.mlSignalUsed ? 1 : 0,
    });
    return entry;
  },

  getAuditEntry(auditId) {
    const row = db().prepare('SELECT * FROM institutional_audit WHERE auditId = ?').get(auditId);
    if (!row) return null;
    return { ...row, inputs: JSON.parse(row.inputs), outputs: JSON.parse(row.outputs), mlSignalUsed: Boolean(row.mlSignalUsed) };
  },

  listAudit({ limit = 50, mode = null, analysisType = null } = {}) {
    const conditions = ['1=1'];
    const params     = [];
    if (mode)         { conditions.push('mode = ?');         params.push(mode); }
    if (analysisType) { conditions.push('analysisType = ?'); params.push(analysisType); }
    params.push(Math.min(500, Number(limit) || 50));
    return db()
      .prepare(`SELECT * FROM institutional_audit WHERE ${conditions.join(' AND ')} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params)
      .map((r) => ({ ...r, inputs: JSON.parse(r.inputs), outputs: JSON.parse(r.outputs), mlSignalUsed: Boolean(r.mlSignalUsed) }));
  },

  // ── Scenarios ──────────────────────────────────────────────────────────────

  saveScenario(scenario) {
    db().prepare(`
      INSERT INTO institutional_scenarios
        (scenarioId, auditId, name, packId, mode, inputs, results, createdAt)
      VALUES
        (@scenarioId, @auditId, @name, @packId, @mode, @inputs, @results, @createdAt)
    `).run({
      ...scenario,
      inputs:  JSON.stringify(scenario.inputs),
      results: JSON.stringify(scenario.results),
    });
    return scenario;
  },

  listScenarios({ limit = 50, mode = null } = {}) {
    const conditions = ['1=1'];
    const params     = [];
    if (mode) { conditions.push('mode = ?'); params.push(mode); }
    params.push(Math.min(500, Number(limit) || 50));
    return db()
      .prepare(`SELECT * FROM institutional_scenarios WHERE ${conditions.join(' AND ')} ORDER BY createdAt DESC LIMIT ?`)
      .all(...params)
      .map((r) => ({ ...r, inputs: JSON.parse(r.inputs), results: JSON.parse(r.results) }));
  },

  getScenario(scenarioId) {
    const row = db().prepare('SELECT * FROM institutional_scenarios WHERE scenarioId = ?').get(scenarioId);
    if (!row) return null;
    return { ...row, inputs: JSON.parse(row.inputs), results: JSON.parse(row.results) };
  },
};
