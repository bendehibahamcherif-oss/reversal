import Database from 'better-sqlite3';
import { join } from 'node:path';
import { DATA_DIR, ensureDataDir } from '../utils/storagePaths.js';

ensureDataDir();
const DB_PATH = join(DATA_DIR, 'reversal.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _initSchema(_db);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id              TEXT PRIMARY KEY,
      symbol          TEXT NOT NULL,
      strategy_id     TEXT,
      strategy_name   TEXT,
      timeframe       TEXT NOT NULL,
      run_type        TEXT NOT NULL DEFAULT 'standard',
      no_lookahead_verified INTEGER NOT NULL DEFAULT 1,
      dataset_version TEXT,
      source_provider TEXT,
      candle_range_start INTEGER,
      candle_range_end   INTEGER,
      candle_count       INTEGER,
      config_json        TEXT,
      metrics_json       TEXT,
      trades_json        TEXT,
      warnings_json      TEXT,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bt_runs_symbol     ON backtest_runs(symbol);
    CREATE INDEX IF NOT EXISTS idx_bt_runs_created_at ON backtest_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS backtest_walk_forward_runs (
      id                     TEXT PRIMARY KEY,
      symbol                 TEXT NOT NULL,
      strategy_id            TEXT,
      timeframe              TEXT NOT NULL,
      windows_json           TEXT,
      aggregate_metrics_json TEXT,
      config_json            TEXT,
      warnings_json          TEXT,
      created_at             TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wf_runs_symbol ON backtest_walk_forward_runs(symbol);

    CREATE TABLE IF NOT EXISTS backtest_monte_carlo_runs (
      id               TEXT PRIMARY KEY,
      base_run_id      TEXT NOT NULL,
      symbol           TEXT NOT NULL,
      iterations       INTEGER NOT NULL,
      distribution_json TEXT,
      summary_json      TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mc_runs_base_run_id ON backtest_monte_carlo_runs(base_run_id);
  `);
}

class BacktestStore {
  saveRun(run) {
    const db = getDb();
    db.prepare(`
      INSERT OR REPLACE INTO backtest_runs
        (id, symbol, strategy_id, strategy_name, timeframe, run_type,
         no_lookahead_verified, dataset_version, source_provider,
         candle_range_start, candle_range_end, candle_count,
         config_json, metrics_json, trades_json, warnings_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      run.id, run.symbol, run.strategyId ?? null, run.strategyName ?? null,
      run.timeframe, run.runType ?? 'standard',
      run.noLookaheadVerified ? 1 : 0,
      run.datasetVersion ?? null, run.sourceProvider ?? null,
      run.candleRangeStart ?? null, run.candleRangeEnd ?? null, run.candleCount ?? null,
      JSON.stringify(run.config ?? {}),
      JSON.stringify(run.metrics ?? {}),
      JSON.stringify(run.trades ?? []),
      JSON.stringify(run.warnings ?? []),
      run.createdAt ?? new Date().toISOString(),
    );
  }

  getRuns(symbol, limit = 50) {
    if (symbol == null || String(symbol).trim() === '') {
      return this.getAllRuns(limit);
    }
    return getDb()
      .prepare('SELECT * FROM backtest_runs WHERE symbol=? ORDER BY created_at DESC LIMIT ?')
      .all(String(symbol).toUpperCase(), limit)
      .map(_deserializeRun);
  }

  getAllRuns(limit = 50) {
    return getDb()
      .prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(_deserializeRun);
  }

  getRunById(id) {
    const row = getDb().prepare('SELECT * FROM backtest_runs WHERE id=?').get(String(id));
    return row ? _deserializeRun(row) : null;
  }

  saveWalkForwardRun(run) {
    getDb().prepare(`
      INSERT OR REPLACE INTO backtest_walk_forward_runs
        (id, symbol, strategy_id, timeframe, windows_json, aggregate_metrics_json,
         config_json, warnings_json, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      run.id, run.symbol, run.strategyId ?? null, run.timeframe,
      JSON.stringify(run.windows ?? []),
      JSON.stringify(run.aggregateMetrics ?? {}),
      JSON.stringify(run.config ?? {}),
      JSON.stringify(run.warnings ?? []),
      run.createdAt ?? new Date().toISOString(),
    );
  }

  getWalkForwardRuns(symbol, limit = 20) {
    return getDb()
      .prepare('SELECT * FROM backtest_walk_forward_runs WHERE symbol=? ORDER BY created_at DESC LIMIT ?')
      .all(String(symbol).toUpperCase(), limit)
      .map((r) => ({
        id: r.id, symbol: r.symbol, strategyId: r.strategy_id, timeframe: r.timeframe,
        windows: JSON.parse(r.windows_json || '[]'),
        aggregateMetrics: JSON.parse(r.aggregate_metrics_json || '{}'),
        config: JSON.parse(r.config_json || '{}'),
        warnings: JSON.parse(r.warnings_json || '[]'),
        createdAt: r.created_at,
      }));
  }

  saveMonteCarloRun(run) {
    getDb().prepare(`
      INSERT OR REPLACE INTO backtest_monte_carlo_runs
        (id, base_run_id, symbol, iterations, distribution_json, summary_json, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      run.id, run.baseRunId, run.symbol, run.iterations,
      JSON.stringify(run.distribution ?? {}),
      JSON.stringify(run.summary ?? {}),
      run.createdAt ?? new Date().toISOString(),
    );
  }

  getMonteCarloRuns(baseRunId) {
    return getDb()
      .prepare('SELECT * FROM backtest_monte_carlo_runs WHERE base_run_id=? ORDER BY created_at DESC')
      .all(String(baseRunId))
      .map((r) => ({
        id: r.id, baseRunId: r.base_run_id, symbol: r.symbol, iterations: r.iterations,
        distribution: JSON.parse(r.distribution_json || '{}'),
        summary: JSON.parse(r.summary_json || '{}'),
        createdAt: r.created_at,
      }));
  }
}

function _deserializeRun(row) {
  return {
    id: row.id, symbol: row.symbol, strategyId: row.strategy_id,
    strategyName: row.strategy_name, timeframe: row.timeframe,
    runType: row.run_type, noLookaheadVerified: row.no_lookahead_verified === 1,
    datasetVersion: row.dataset_version, sourceProvider: row.source_provider,
    candleRangeStart: row.candle_range_start, candleRangeEnd: row.candle_range_end,
    candleCount: row.candle_count,
    config: JSON.parse(row.config_json || '{}'),
    metrics: JSON.parse(row.metrics_json || '{}'),
    trades: JSON.parse(row.trades_json || '[]'),
    warnings: JSON.parse(row.warnings_json || '[]'),
    createdAt: row.created_at,
  };
}

export const backtestStore = new BacktestStore();
