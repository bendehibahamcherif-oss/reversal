import { Router } from 'express';
import { backtestEngine } from '../backtest/backtestEngine.js';

const backtestRoutes = Router();

backtestRoutes.post('/run/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const { strategyId, timeframe = '1m' } = req.body || {};
  const result = backtestEngine.runBacktest(symbol, strategyId, timeframe);
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

export default backtestRoutes;
