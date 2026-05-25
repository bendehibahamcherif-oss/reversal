import { Router } from 'express';
import { patternEngine } from '../patterns/patternEngine.js';
import { getCandles } from '../persistence/historicalStore.js';

const patternRoutes = Router();

patternRoutes.get('/signals/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ ok: true, symbol, patterns: patternEngine.getPatterns(symbol) });
});

patternRoutes.post('/analyze/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const candles = getCandles(symbol, timeframe);

  const candlePatterns = patternEngine.analyzeCandles(symbol, timeframe, candles);
  const providedBook = req.body?.orderBook || null;
  const runtimeBook = req.app?.locals?.orderBookEngine?.getSnapshot?.(symbol) || null;
  const bookPatterns = patternEngine.analyzeOrderBook(symbol, providedBook || runtimeBook);
  const tickPatterns = req.body?.tick ? patternEngine.analyzeTick(symbol, req.body.tick) : [];

  return res.json({
    ok: true,
    symbol,
    timeframe,
    marketOpen: req.app?.locals?.marketRegistry?.isOpen?.() ?? null,
    patterns: [...candlePatterns, ...bookPatterns, ...tickPatterns],
    totalStored: patternEngine.getPatterns(symbol).length,
  });
});

patternRoutes.delete('/signals/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  patternEngine.clearPatterns(symbol);
  return res.json({ ok: true, symbol, patterns: [] });
});

export default patternRoutes;
