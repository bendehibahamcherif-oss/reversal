import { Router } from 'express';
import { strategyLabEngine } from '../strategyLab/strategyLabEngine.js';
import { strategyLabStore } from '../strategyLab/strategyLabStore.js';

const strategyLabRoutes = Router();

function buildManualStrategyPayload(req, symbolFromPath) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const normalizedSymbol = String(symbolFromPath || body.symbol || '').toUpperCase();

  return {
    symbol: normalizedSymbol,
    name: body.name,
    type: body.type,
    direction: body.direction,
    timeframe: body.timeframe,
    entryLogic: body.entryLogic,
    exitLogic: body.exitLogic,
    riskRules: body.riskRules,
    notes: body.notes,
    tags: body.tags,
    candidateId: body.candidateId,
  };
}

async function saveStrategyHandler(req, res) {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const candidateId = String(req.params.candidateId || req.body?.candidateId || '');

  if (candidateId) {
    const strategy = await strategyLabEngine.saveFromCandidate(symbol, candidateId);
    if (!strategy) return res.status(404).json({ success: false, error: 'Strategy candidate not found' });
    return res.json({ success: true, symbol, strategy });
  }

  const strategy = await strategyLabEngine.saveManualStrategy(buildManualStrategyPayload(req, symbol));
  return res.json({ success: true, symbol, strategy });
}

strategyLabRoutes.options('/save/:symbol', (req, res) => res.sendStatus(204));
strategyLabRoutes.options('/strategies/:symbol', (req, res) => res.sendStatus(204));
strategyLabRoutes.post('/save/:symbol/:candidateId', saveStrategyHandler);
strategyLabRoutes.post('/save/:symbol', saveStrategyHandler);
strategyLabRoutes.post('/strategies/:symbol', saveStrategyHandler);

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
