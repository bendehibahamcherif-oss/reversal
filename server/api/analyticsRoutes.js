import { Router } from 'express';
import { analysisTrendEngine } from '../analytics/analysisTrendEngine.js';

const analyticsRoutes = Router();

analyticsRoutes.get('/trend/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const limit = req.query?.limit;
  const trend = await analysisTrendEngine.computeTrend(symbol, limit);
  return res.json({ ok: true, symbol, trend });
});

analyticsRoutes.post('/compare/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const baseSnapshotId = req.body?.baseSnapshotId || req.query?.baseSnapshotId || '';
  const compareSnapshotId = req.body?.compareSnapshotId || req.query?.compareSnapshotId || '';

  const comparison = await analysisTrendEngine.compareSnapshots(symbol, baseSnapshotId, compareSnapshotId);
  return res.json({ ok: true, symbol, comparison });
});

analyticsRoutes.get('/latest/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const latest = await analysisTrendEngine.getLatestTrend(symbol);
  return res.json({ ok: true, symbol, ...latest });
});

export default analyticsRoutes;
