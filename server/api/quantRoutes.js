import { Router } from 'express';
import { quantFeatureEngine } from '../quant/quantFeatureEngine.js';
import { quantPipelineEngine } from '../quant/quantPipelineEngine.js';
import { analysisHistoryStore } from '../history/analysisHistoryStore.js';

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

const handlePipelineAnalysis = async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const result = quantPipelineEngine.runFullAnalysis(symbol, timeframe);

  if (req.method === 'POST' && result?.success) {
    const snapshot = await analysisHistoryStore.saveSnapshot(result);
    return res.json({
      ...result,
      snapshotId: snapshot?.id || null,
    });
  }

  return res.json(result);
};

quantRoutes.get('/pipeline/:symbol', handlePipelineAnalysis);
quantRoutes.post('/pipeline/:symbol', handlePipelineAnalysis);

quantRoutes.get('/history/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const limit = req.query?.limit;
  const snapshots = await analysisHistoryStore.getSnapshots(symbol, limit);

  return res.json({ ok: true, symbol, snapshots });
});

quantRoutes.get('/history/snapshot/:id', async (req, res) => {
  const snapshot = await analysisHistoryStore.getSnapshotById(req.params.id);
  if (!snapshot) return res.status(404).json({ ok: false, error: 'Snapshot not found' });
  return res.json({ ok: true, snapshot });
});

quantRoutes.delete('/history/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = await analysisHistoryStore.clearSnapshots(symbol);
  return res.json({ ok: true, symbol, deleted: result.deleted });
});

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
