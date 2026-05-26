import { Router } from 'express';
import { sessionContextEngine } from '../sessionContext/sessionContextEngine.js';

const sessionContextRoutes = Router();

sessionContextRoutes.get('/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const context = sessionContextEngine.getLatestContext(symbol);

  return res.json({
    ok: true,
    symbol,
    context,
    warnings: context?.warnings || [],
  });
});

sessionContextRoutes.post('/compute/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const context = sessionContextEngine.computeSessionContext(symbol, timeframe);

  return res.json({ ok: true, symbol, timeframe, context });
});

sessionContextRoutes.delete('/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = sessionContextEngine.clearContext(symbol);
  return res.json({ ok: true, ...result });
});

export default sessionContextRoutes;
