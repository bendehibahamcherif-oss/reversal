import { Router } from 'express';
import { strategyLabEngine } from '../strategyLab/strategyLabEngine.js';
import { strategyLabStore } from '../strategyLab/strategyLabStore.js';

const strategyLabRoutes = Router();

strategyLabRoutes.post('/save/:symbol/:candidateId', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const candidateId = String(req.params.candidateId || '');
  const strategy = await strategyLabEngine.saveFromCandidate(symbol, candidateId);
  if (!strategy) return res.status(404).json({ ok: false, error: 'Strategy candidate not found' });
  return res.json({ ok: true, symbol, strategy });
});

strategyLabRoutes.post('/save', async (req, res) => {
  const strategy = await strategyLabEngine.saveManualStrategy(req.body || {});
  return res.json({ ok: true, strategy });
});

strategyLabRoutes.get('/strategies/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const strategies = await strategyLabStore.getStrategies(symbol);
  return res.json({ ok: true, symbol, strategies });
});

strategyLabRoutes.get('/strategies', async (req, res) => {
  const strategies = await strategyLabStore.getStrategies('');
  return res.json({ ok: true, strategies });
});

strategyLabRoutes.post('/backtest/:id', async (req, res) => {
  const strategy = await strategyLabEngine.attachBacktestResult(req.params.id, req.body || {});
  if (!strategy) return res.status(404).json({ ok: false, error: 'Saved strategy not found' });
  return res.json({ ok: true, strategy });
});

strategyLabRoutes.post('/validation/:id', async (req, res) => {
  const strategy = await strategyLabEngine.attachValidationResult(req.params.id, req.body || {});
  if (!strategy) return res.status(404).json({ ok: false, error: 'Saved strategy not found' });
  return res.json({ ok: true, strategy });
});

strategyLabRoutes.post('/compare/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const ids = Array.isArray(req.body?.strategyIds) ? req.body.strategyIds.map((id) => String(id || '')) : [];
  const comparison = await strategyLabEngine.compareStrategies(symbol, ids);
  return res.json({ ok: true, ...comparison });
});

strategyLabRoutes.delete('/strategy/:id', async (req, res) => {
  const result = await strategyLabStore.deleteStrategy(req.params.id);
  return res.json({ ok: true, ...result });
});

strategyLabRoutes.delete('/strategies/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = await strategyLabStore.clearStrategies(symbol);
  return res.json({ ok: true, symbol, ...result });
});

export default strategyLabRoutes;
