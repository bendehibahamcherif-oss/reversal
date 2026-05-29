import { Router } from 'express';
import { backtestEngine } from '../backtest/backtestEngine.js';
import { backtestStore } from '../backtest/backtestStore.js';
import { exportHtmlReport } from '../backtest/backtestReportExporter.js';
import { strategyEngine } from '../strategies/strategyEngine.js';

const backtestRoutes = Router();

// ── Existing routes (backward-compat) ────────────────────────────────────────

backtestRoutes.post('/run/:symbol', (req, res) => {
  const symbol    = String(req.params.symbol || '').toUpperCase();
  const { strategyId, timeframe = '1m', config = {} } = req.body || {};
  const result = backtestEngine.runBacktest(symbol, strategyId, timeframe, config);
  return res.json({ ok: true, symbol, result });
});

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
backtestRoutes.get('/runs/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const runs   = backtestStore.getRuns(symbol, limit);
  return res.json({ ok: true, symbol, runs });
});

backtestRoutes.get('/runs/:symbol/:id', (req, res) => {
  const run = backtestStore.getRunById(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
  return res.json({ ok: true, run });
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

// HTML export
backtestRoutes.get('/export/:symbol/:runId', (req, res) => {
  const run = backtestStore.getRunById(req.params.runId);
  if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
  const html = exportHtmlReport(run);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="backtest-${run.symbol}-${run.timeframe}-${run.id.slice(0, 8)}.html"`);
  return res.send(html);
});

export default backtestRoutes;
