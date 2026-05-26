import { Router } from 'express';
import { chartDataEngine } from '../charting/chartDataEngine.js';

const chartRoutes = Router();

chartRoutes.get('/candles/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const limit = Number(req.query?.limit || 200);
  return res.json({ success: true, ...chartDataEngine.getCandles(req.params.symbol, timeframe, limit) });
});

chartRoutes.get('/indicators/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const indicators = String(req.query?.indicators || 'vwap,ema9,ema20,rsi14,volume_avg,volume_zscore').split(',');
  return res.json({ success: true, ...chartDataEngine.getIndicators(req.params.symbol, timeframe, indicators) });
});

chartRoutes.get('/overlays/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  return res.json({ success: true, ...chartDataEngine.getOverlays(req.params.symbol, timeframe) });
});

chartRoutes.get('/orderflow/:symbol', (req, res) => res.json({ success: true, ...chartDataEngine.getOrderflow(req.params.symbol) }));
chartRoutes.get('/payload/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const limit = Number(req.query?.limit || 200);
  return res.json({ success: true, ...chartDataEngine.buildChartPayload(req.params.symbol, timeframe, limit) });
});

export default chartRoutes;
