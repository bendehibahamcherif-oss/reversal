import { Router } from 'express';
import { chartDataEngine } from '../charting/chartDataEngine.js';
import { cvdEngine } from '../charting/cvdEngine.js';
import { footprintEngine } from '../charting/footprintEngine.js';

const chartRoutes = Router();

// ── Candles ──────────────────────────────────────────────────────────────────

chartRoutes.get('/candles/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const limit     = Number(req.query?.limit || 200);
  return res.json({
    success: true,
    ...await chartDataEngine.getCandles(req.params.symbol, timeframe, limit),
  });
});

// ── Indicators ───────────────────────────────────────────────────────────────

chartRoutes.get('/indicators/:symbol', async (req, res) => {
  const timeframe  = req.query?.timeframe || '1m';
  const indicators = String(
    req.query?.indicators || 'vwap,ema9,ema20,rsi14,volume_avg,volume_zscore',
  ).split(',');
  return res.json({
    success: true,
    ...await chartDataEngine.getIndicators(req.params.symbol, timeframe, indicators),
  });
});

// ── Overlays ─────────────────────────────────────────────────────────────────

chartRoutes.get('/overlays/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  return res.json({
    success: true,
    ...chartDataEngine.getOverlays(req.params.symbol, timeframe),
  });
});

// ── Orderflow ────────────────────────────────────────────────────────────────

chartRoutes.get('/orderflow/:symbol', (req, res) => {
  return res.json({
    success: true,
    ...chartDataEngine.getOrderflow(req.params.symbol),
  });
});

// ── Full chart payload ────────────────────────────────────────────────────────

chartRoutes.get('/payload/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const limit     = Number(req.query?.limit || 200);
  const payload   = await chartDataEngine.buildChartPayload(req.params.symbol, timeframe, limit);

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

// GET /api/chart/footprint/:symbol
// Returns per-bar, per-price-level footprint clusters.
// Query params:
//   timeframe          (default: 1m)
//   limit              (default: 50, max: 200)   — fewer bars by default due to payload size
//   clusterSize        (default: auto-scaled)     — price increment per level
//   imbalanceThreshold (default: 3.0)             — min ratio to flag imbalance
chartRoutes.get('/footprint/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });

    const timeframe          = String(req.query.timeframe || '1m');
    const limit              = Math.min(200, Math.max(5, parseInt(req.query.limit, 10) || 50));
    const clusterSize        = req.query.clusterSize ? parseFloat(req.query.clusterSize) : null;
    const imbalanceThreshold = Math.max(1.1, parseFloat(req.query.imbalanceThreshold) || 3.0);

    const candlePayload = await chartDataEngine.getCandles(symbol, timeframe, limit);
    const candles       = candlePayload.candles || [];

    // Cache for WebSocket push
    footprintEngine.setLatestCandles(symbol, candles, candlePayload.source);

    const fp = footprintEngine.compute(candles, candlePayload.source, {
      clusterSize,
      imbalanceThreshold,
    });

    return res.json({
      success:            true,
      symbol,
      timeframe,
      limit,
      clusterSize:        fp.clusterSize,
      imbalanceThreshold: fp.imbalanceThreshold,
      source:             fp.source,
      fallback:           fp.fallback,
      imbalancesDisabled: fp.imbalancesDisabled,
      bars:               fp.bars,
      candleSource:       candlePayload.source,
      warnings: [
        ...candlePayload.warnings,
        ...(fp.imbalancesDisabled
          ? ['Imbalance and absorption markers are disabled: data source is synthetic OHLCV approximation, not real bid/ask order flow.']
          : []),
      ],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default chartRoutes;
