import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const replayRoutes = Router();

replayRoutes.get('/candles/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const requestedTimeframe = String(req.query?.timeframe || '1m');
  const timeframe = ['1m', '5m', '15m', '1H'].includes(requestedTimeframe) ? requestedTimeframe : '1m';
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const limit = Math.max(1, Number(req.query?.limit || 200));
  const payload = await feedManager.getReplayCandles(normalizedSymbol, timeframe, limit);

  res.json({
    success: true,
    symbol: normalizedSymbol,
    timeframe,
    source: payload?.source || 'fallback_demo',
    warning: payload?.warning || null,
    candles: Array.isArray(payload?.candles) ? payload.candles : [],
  });
});

export default replayRoutes;
