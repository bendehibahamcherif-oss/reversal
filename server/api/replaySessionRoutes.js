import { Router } from 'express';

import { getCandles } from '../persistence/historicalStore.js';

const replayLegacyRoutes = Router();

replayLegacyRoutes.get('/candles/:symbol', (req, res) => {
  const { symbol } = req.params;
  const requestedTimeframe = String(req.query?.timeframe || '1m');
  const timeframe = ['1m', '5m', '15m', '1H'].includes(requestedTimeframe) ? requestedTimeframe : '1m';
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const candles = getCandles(symbol, timeframe);

  res.json({
    success: true,
    symbol: normalizedSymbol,
    timeframe,
    candles: Array.isArray(candles) ? candles : [],
  });
});

export default replayLegacyRoutes;
