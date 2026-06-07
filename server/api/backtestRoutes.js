import { Router } from 'express';
import { backtestEngine } from '../backtest/backtestEngine.js';
import { backtestStore } from '../backtest/backtestStore.js';
import { exportHtmlReport } from '../backtest/backtestReportExporter.js';
import { strategyEngine } from '../strategies/strategyEngine.js';
import { readDatasetCandlesAsync } from '../historical/historicalDataService.js';
import { sanitizeJson } from '../historical/jsonSafety.js';

const backtestRoutes = Router();

// ── Existing routes (backward-compat) ────────────────────────────────────────

async function runBacktestHandler(req, res) {
  const symbol    = String(req.params.symbol || req.body?.symbol || '').toUpperCase();
  const { strategyId, timeframe = '1m', config = {}, datasetId } = req.body || {};

  if (!datasetId || String(datasetId).trim().toLowerCase() === 'undefined' || String(datasetId).trim().toLowerCase() === 'null') {
    return res.status(400).json(sanitizeJson({ ok: false, status: 'dataset_required', message: 'datasetId is required for production backtests.' }));
  }
  if (String(datasetId).trim() === 'fallback_demo') {
    return res.status(400).json(sanitizeJson({ ok: false, status: 'dataset_not_usable_for_target', message: 'fallback_demo cannot be used as a real historical backtest dataset.', datasetId }));
  }

  let dataSource = null;
  let historicalCandles = null;
  if (datasetId) {
    const read = await readDatasetCandlesAsync(datasetId);
    if (!read.ok) {
      const status = read.error === 'dataset_not_found' ? 404 : 200;
      const message = read.error === 'dataset_not_found' ? 'Historical dataset not found.' : 'Historical dataset exists but no usable CSV/Parquet file was found.';
      return res.status(status).json(sanitizeJson({ ok: false, status: read.error, error: read.error, message, datasetId }));
    }
    historicalCandles = read.candles;
    dataSource = { type: 'historical_dataset', datasetId: read.dataset?.datasetId || datasetId, provider: read.dataset?.provider, rowCount: read.dataset?.rowCount ?? historicalCandles.length };
  }

  const result = backtestEngine.runBacktest(symbol, strategyId, timeframe, config, historicalCandles);
  if (datasetId && (!Array.isArray(historicalCandles) || historicalCandles.length < 2)) {
    return res.status(200).json(sanitizeJson({ ok: true, symbol, result, dataSource, status: 'not_enough_data', message: 'Not enough historical dataset rows for backtesting.' }));
  }
  return res.json(sanitizeJson({ ok: true, symbol, result, dataSource }));
}

backtestRoutes.post('/run/:symbol', runBacktestHandler);
backtestRoutes.post('/run', runBacktestHandler);

backtestRoutes.get('/results/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ ok: true, symbol, results: backtestEngine.getBacktestResults(symbol) });
});

backtestRoutes.get('/results/:symbol/:id', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = backtestEngine.getBacktestResultById(symbol, req.params.id);
  return res.json({ ok: true, symbol, result });
});

backtestRoutes.delete('/results/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  backtestEngine.clearBacktestResults(symbol);
  return res.json({ ok: true, symbol, results: [] });
});

// ── New routes ────────────────────────────────────────────────────────────────

// Persistent run history (from SQLite)
backtestRoutes.get('/runs', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const runs   = backtestStore.getRuns(symbol || undefined, limit);
  return res.json(sanitizeJson({ ok: true, symbol, runs, count: Array.isArray(runs) ? runs.length : 0 }));
});

backtestRoutes.get('/runs/:symbolOrRunId', (req, res) => {
  const value = String(req.params.symbolOrRunId || '');
  const run = backtestStore.getRunById(value);
  if (run) return res.json(sanitizeJson({ ok: true, run }));

  const symbol = value.toUpperCase();
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const runs   = backtestStore.getRuns(symbol, limit);
  return res.json(sanitizeJson({ ok: true, symbol, runs, count: Array.isArray(runs) ? runs.length : 0 }));
});

backtestRoutes.get('/runs/:symbol/:id', (req, res) => {
  const run = backtestStore.getRunById(req.params.id);
  if (!run) return res.status(404).json({ ok: false, status: 'run_not_found', message: 'Backtest run not found.', runId: req.params.id });
  return res.json(sanitizeJson({ ok: true, run }));
});

// Walk-forward backtest
backtestRoutes.post('/walk-forward/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const { strategyId, timeframe = '1m', options = {}, config = {} } = req.body || {};
  const strategies = strategyEngine.getStrategies(symbol);
  const candidate  = strategyId
    ? strategies.find((s) => s.id === strategyId)
    : strategies[strategies.length - 1] ?? null;

  const result = backtestEngine.walkForwardBacktest(symbol, candidate, timeframe, options, config);
  return res.json({ ok: true, symbol, result });
});

backtestRoutes.get('/walk-forward/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const runs   = backtestStore.getWalkForwardRuns(symbol);
  return res.json({ ok: true, symbol, runs });
});

// Monte Carlo resampling on a persisted run
backtestRoutes.post('/monte-carlo/:symbol/:runId', (req, res) => {
  const runId      = String(req.params.runId || '');
  const iterations = Math.min(10_000, Math.max(100, parseInt(req.body?.iterations, 10) || 1000));
  const result     = backtestEngine.monteCarloResample(runId, iterations);
  if (!result) return res.status(404).json({ ok: false, error: 'Base run not found' });
  return res.json({ ok: true, result });
});

backtestRoutes.get('/monte-carlo/:symbol/:runId', (req, res) => {
  const runs = backtestStore.getMonteCarloRuns(req.params.runId);
  return res.json({ ok: true, runs });
});

// HTML report export metadata. `/api/*` must remain JSON-only, so the generated
// report is returned as a JSON string instead of an HTML response body.
backtestRoutes.get('/export/:symbol/:runId', (req, res) => {
  const run = backtestStore.getRunById(req.params.runId);
  if (!run) return res.status(404).json({ ok: false, status: 'run_not_found', message: 'Backtest run not found.', runId: req.params.runId });
  const html = exportHtmlReport(run);
  const filename = `backtest-${run.symbol}-${run.timeframe}-${run.id.slice(0, 8)}.html`;
  return res.json(sanitizeJson({ ok: true, status: 'available', filename, contentType: 'text/html; charset=utf-8', html }));
});

export default backtestRoutes;
