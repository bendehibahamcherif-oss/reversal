import { Router } from 'express';
import { chartDataEngine } from '../charting/chartDataEngine.js';
import { cvdEngine } from '../charting/cvdEngine.js';

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

// GET /api/chart/cvd/:symbol
// Returns bar-aligned cumulative delta volume with explicit source tagging.
// Query params:
//   timeframe  (default: 1m)
//   limit      (default: 200, max: 500)
chartRoutes.get('/cvd/:symbol', async (req, res) => {
  try {
    const symbol    = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });

    const timeframe = String(req.query.timeframe || '1m');
    const limit     = Math.min(500, Math.max(10, parseInt(req.query.limit, 10) || 200));

    const candlePayload = await chartDataEngine.getCandles(symbol, timeframe, limit);
    const candles       = candlePayload.candles || [];

    const cvdPayload = cvdEngine.buildCVDPayload(symbol, candles, candlePayload.source);

    return res.json({
      success:              true,
      symbol,
      timeframe,
      limit,
      source:               cvdPayload.source,
      sourceClassification: cvdPayload.sourceClassification,
      fallback:             cvdPayload.fallback,
      sessionResets:        cvdPayload.sessionResets,
      liveState:            cvdPayload.liveState,
      bars:                 cvdPayload.bars,
      candleSource:         candlePayload.source,
      warnings: [
        ...candlePayload.warnings,
        ...(cvdPayload.fallback
          ? [`CVD source is "${cvdPayload.source}"; buy/sell pressure is approximated, not from real order flow.`]
          : []),
      ],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default chartRoutes;
