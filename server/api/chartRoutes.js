import { Router } from 'express';
import { chartDataEngine } from '../charting/chartDataEngine.js';

const chartRoutes = Router();

chartRoutes.get('/candles/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const limit = Number(req.query?.limit || 200);
  return res.json({ success: true, ...await chartDataEngine.getCandles(req.params.symbol, timeframe, limit) });
});

chartRoutes.get('/indicators/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const indicators = String(req.query?.indicators || 'vwap,ema9,ema20,rsi14,volume_avg,volume_zscore').split(',');
  return res.json({ success: true, ...await chartDataEngine.getIndicators(req.params.symbol, timeframe, indicators) });
});

chartRoutes.get('/overlays/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  return res.json({ success: true, ...chartDataEngine.getOverlays(req.params.symbol, timeframe) });
});

chartRoutes.get('/orderflow/:symbol', (req, res) => res.json({ success: true, ...chartDataEngine.getOrderflow(req.params.symbol) }));
chartRoutes.get('/payload/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const limit = Number(req.query?.limit || 200);
  const payload = await chartDataEngine.buildChartPayload(req.params.symbol, timeframe, limit);
  const indicatorsObj = {};
  if (Array.isArray(payload.indicators)) {
    for (const ind of payload.indicators) {
      const vals = Array.isArray(ind.values) ? ind.values : [];
      indicatorsObj[ind.name] = vals.length ? (vals[vals.length - 1]?.value ?? null) : null;
    }
  } else if (payload.indicators && typeof payload.indicators === 'object') {
    Object.assign(indicatorsObj, payload.indicators);
  }
  return res.json({ success: true, ...payload, indicators: indicatorsObj });
});

export default chartRoutes;
