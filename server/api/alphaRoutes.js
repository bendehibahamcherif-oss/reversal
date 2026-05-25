import { Router } from 'express';
import { alphaEngine } from '../alpha/alphaEngine.js';
import { getCandles } from '../persistence/historicalStore.js';

const alphaRoutes = Router();

alphaRoutes.get('/signals/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({
    ok: true,
    symbol,
    signals: alphaEngine.getSignals(symbol),
  });
});

alphaRoutes.post('/analyze/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';

  const candles = getCandles(symbol, timeframe);
  const candleSignals = alphaEngine.analyzeCandles(symbol, timeframe, candles);

  const providedBook = req.body?.orderBook || null;
  const runtimeBook = req.app?.locals?.orderBookEngine?.getSnapshot?.(symbol) || null;
  const orderBookSignals = alphaEngine.analyzeOrderBook(symbol, providedBook || runtimeBook);

  const tickSignals = req.body?.tick
    ? alphaEngine.analyzeTick(symbol, req.body.tick)
    : [];

  return res.json({
    ok: true,
    symbol,
    timeframe,
    marketOpen: req.app?.locals?.marketRegistry?.isOpen?.() ?? null,
    signals: [...candleSignals, ...orderBookSignals, ...tickSignals],
    totalStored: alphaEngine.getSignals(symbol).length,
  });
});

alphaRoutes.delete('/signals/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  alphaEngine.clearSignals(symbol);

  return res.json({
    ok: true,
    symbol,
    signals: [],
  });
});

export default alphaRoutes;
