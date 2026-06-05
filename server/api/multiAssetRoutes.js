import { Router } from 'express';
import { multiAssetEngine } from '../multiAsset/multiAssetEngine.js';

const multiAssetRoutes = Router();

// ── helpers ───────────────────────────────────────────────────────────────────

function parseSymbols(raw) {
  return raw ? String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined;
}

function parseWindow(raw) {
  const n = Number(raw);
  return isFinite(n) && n > 0 ? n : undefined;
}

// ── Correlation matrix ────────────────────────────────────────────────────────

// GET /api/multi-asset/correlation
// Query: symbols (comma-separated), timeframe, window
// Response: { ok, matrix, symbols, window, timeframe, source }
multiAssetRoutes.get('/correlation', (req, res) => {
  const symbols = parseSymbols(req.query.symbols) || ['SPY', 'QQQ', 'IWM', 'GLD', 'TLT'];
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  return res.status(200).json({ ok: true, matrix: [], symbols, window, timeframe, status: 'not_enough_data' });
});

// ── Rolling beta ──────────────────────────────────────────────────────────────

// GET /api/multi-asset/beta
// Query: symbols, benchmark (default SPY), timeframe, window
// Response: { ok, benchmark, symbols, window, timeframe, beta: { [sym]: { beta, correlation, rollingBeta, dataPoints } }, source }
multiAssetRoutes.get('/beta', async (req, res) => {
  try {
    const result = await multiAssetEngine.betaMetrics({
      symbols:   parseSymbols(req.query.symbols),
      benchmark: req.query.benchmark || 'SPY',
      timeframe: req.query.timeframe || '1d',
      window:    parseWindow(req.query.window) ?? 20,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Sector rotation ───────────────────────────────────────────────────────────

// GET /api/multi-asset/sector-rotation
// Query: timeframe, window, benchmark (default SPY)
// Response: { ok, sectors: [{ sector, etf, cumReturn, relReturn, volatility, score, beta, dataPoints }], benchmark, benchmarkCumReturn, window, timeframe, source }
multiAssetRoutes.get('/sector-rotation', (req, res) => {
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  const benchmark = req.query.benchmark || 'SPY';
  return res.status(200).json({ ok: true, sectors: [], benchmark, window, timeframe, status: 'not_enough_data' });
});

// ── Volatility heatmap ────────────────────────────────────────────────────────

// GET /api/multi-asset/volatility
// Query: symbols, timeframe, window
// Response: { ok, heatmap: { [sym]: { currentVol, rollingVol, dataPoints, volRank } }, symbols, window, timeframe, source }
async function volatilityHandler(req, res) {
  try {
    const result = await multiAssetEngine.volatilityHeatmap({
      symbols:   parseSymbols(req.query.symbols),
      timeframe: req.query.timeframe || '1d',
      window:    parseWindow(req.query.window) ?? 20,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

function volatilityHeatmapCompatHandler(req, res) {
  const symbols = parseSymbols(req.query.symbols) || ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'];
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  return res.status(200).json({ ok: true, symbols, heatmap: [], timeframe, window, status: 'not_enough_data' });
}

multiAssetRoutes.get('/volatility', volatilityHandler);
multiAssetRoutes.get('/volatility-heatmap', volatilityHeatmapCompatHandler);

// ── Relative performance ──────────────────────────────────────────────────────

// GET /api/multi-asset/relative-performance
// Query: symbols, benchmark, timeframe, window (optional)
// Response: { ok, benchmark, symbols, timeframe, window, performance: { [sym]: { totalReturn, benchmarkReturn, relativeReturn, cumSeries, dataPoints } }, source }
multiAssetRoutes.get('/relative-performance', async (req, res) => {
  try {
    const result = await multiAssetEngine.relativePerformance({
      symbols:   parseSymbols(req.query.symbols),
      benchmark: req.query.benchmark || 'SPY',
      timeframe: req.query.timeframe || '1d',
      window:    parseWindow(req.query.window) ?? null,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Combined heatmap ──────────────────────────────────────────────────────────

// GET /api/multi-asset/heatmap
// Returns correlation matrix + volatility snapshot for the same symbol set.
// Query: symbols, benchmark, timeframe, window
// Response: { ok, symbols, window, timeframe, benchmark, correlation, volatility, source }
multiAssetRoutes.get('/heatmap', async (req, res) => {
  try {
    const symbols   = parseSymbols(req.query.symbols);
    const timeframe = req.query.timeframe || '1d';
    const window    = parseWindow(req.query.window) ?? 20;
    const benchmark = req.query.benchmark || 'SPY';

    const [corr, vol] = await Promise.all([
      multiAssetEngine.correlationMatrix({ symbols, timeframe, window }),
      multiAssetEngine.volatilityHeatmap({ symbols, timeframe, window }),
    ]);

    return res.json({
      ok:          true,
      symbols:     corr.symbols,
      window,
      timeframe,
      benchmark,
      correlation: corr.matrix,
      volatility:  vol.heatmap,
      source:      corr.source,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Sector catalogue ──────────────────────────────────────────────────────────

// GET /api/multi-asset/sectors
// Response: { ok, sectors: { [name]: etfSymbol } }
multiAssetRoutes.get('/sectors', (_req, res) => {
  return res.json({ ok: true, sectors: multiAssetEngine.SECTOR_ETFS });
});

export default multiAssetRoutes;
