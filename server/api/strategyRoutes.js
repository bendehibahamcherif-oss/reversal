import { Router } from 'express';
import { strategyEngine } from '../strategies/strategyEngine.js';

const strategyRoutes = Router();

strategyRoutes.get('/candidates/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({
    ok: true,
    symbol,
    strategies: strategyEngine.getStrategies(symbol),
  });
});

strategyRoutes.post('/generate/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const strategies = strategyEngine.generateForSymbol(symbol, timeframe);

  return res.json({
    ok: true,
    symbol,
    timeframe,
    strategies,
  });
});

strategyRoutes.delete('/candidates/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  strategyEngine.clearStrategies(symbol);
  return res.json({ ok: true, symbol, strategies: [] });
});

export default strategyRoutes;
