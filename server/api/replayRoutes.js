import { Router } from 'express';

import { getCandles } from '../persistence/historicalStore.js';

const replayRoutes = Router();

replayRoutes.get('/candles/:symbol', (req, res) => {
  const { symbol } = req.params;

  res.json({
    ok: true,
    route: 'replay',
    symbol: String(symbol || '').toUpperCase(),
    candles: getCandles(symbol),
  });
});

export default replayRoutes;
