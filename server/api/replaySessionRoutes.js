import { Router } from 'express';

import { getCandles } from '../persistence/historicalStore.js';

const replayLegacyRoutes = Router();

replayLegacyRoutes.get('/candles/:symbol', (req, res) => {
  const { symbol } = req.params;

  res.json({
    ok: true,
    route: 'replay-legacy',
    symbol: String(symbol || '').toUpperCase(),
    candles: getCandles(symbol),
  });
});

export default replayLegacyRoutes;
