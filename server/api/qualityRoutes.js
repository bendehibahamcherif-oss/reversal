import { Router } from 'express';
import { qualityEngine } from '../quality/qualityEngine.js';
import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { strategyEngine } from '../strategies/strategyEngine.js';
import { quantFeatureEngine } from '../quant/quantFeatureEngine.js';

const qualityRoutes = Router();

qualityRoutes.get('/scores/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ ok: true, symbol, qualityScores: qualityEngine.getQualityScores(symbol) });
});

qualityRoutes.post('/score/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';

  const alphaSignals = alphaEngine.analyzeCandles(symbol, timeframe);
  const patternSignals = patternEngine.analyzeCandles(symbol, timeframe);
  const strategyCandidates = strategyEngine.generateForSymbol(symbol, timeframe);
  const quantFeatures = quantFeatureEngine.extractForSymbol(symbol, timeframe);

  const qualityScores = qualityEngine.scoreSignals(
    symbol,
    alphaSignals,
    patternSignals,
    strategyCandidates,
    quantFeatures,
  );

  return res.json({
    ok: true,
    symbol,
    timeframe,
    qualityScores,
    rankedSignals: qualityEngine.rankSignals(symbol),
  });
});

qualityRoutes.delete('/scores/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  qualityEngine.clearQualityScores(symbol);
  return res.json({ ok: true, symbol, qualityScores: [] });
});

export default qualityRoutes;
