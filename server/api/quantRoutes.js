import { Router } from 'express';
import { quantFeatureEngine } from '../quant/quantFeatureEngine.js';
import { quantPipelineEngine } from '../quant/quantPipelineEngine.js';

const quantRoutes = Router();

quantRoutes.get('/features/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();

  return res.json({
    ok: true,
    symbol,
    features: quantFeatureEngine.getFeatures(symbol),
  });
});

quantRoutes.post('/extract/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const providedBook = req.body?.orderBook || null;
  const runtimeBook = req.app?.locals?.orderBookEngine?.getBook?.(symbol)
    || req.app?.locals?.orderBookEngine?.getSnapshot?.(symbol)
    || null;

  const features = quantFeatureEngine.extractForSymbol(symbol, timeframe, providedBook || runtimeBook);

  return res.json({
    ok: true,
    symbol,
    timeframe,
    features,
  });
});

const handlePipelineAnalysis = (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const result = quantPipelineEngine.runFullAnalysis(symbol, timeframe);

  return res.json(result);
};

quantRoutes.get('/pipeline/:symbol', handlePipelineAnalysis);
quantRoutes.post('/pipeline/:symbol', handlePipelineAnalysis);

quantRoutes.delete('/features/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  quantFeatureEngine.clearFeatures(symbol);

  return res.json({
    ok: true,
    symbol,
    features: [],
  });
});

export default quantRoutes;
