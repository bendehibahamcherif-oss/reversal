import { Router } from 'express';
import { reversalDetectorEngine } from '../reversal/reversalDetectorEngine.js';

const reversalRoutes = Router();

reversalRoutes.get('/points/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const reversalPoints = reversalDetectorEngine.getReversalPoints(symbol);
  return res.json({ ok: true, symbol, reversalPoints, warnings: reversalPoints.length === 0 ? ['No stored reversal points for symbol.'] : [] });
});

reversalRoutes.post('/detect/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const result = reversalDetectorEngine.detectReversals(symbol, timeframe);
  return res.json({ ok: true, ...result });
});

reversalRoutes.delete('/points/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = reversalDetectorEngine.clearReversalPoints(symbol);
  return res.json({ ok: true, ...result });
});

export default reversalRoutes;
