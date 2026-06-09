import { Router } from 'express';
import { readDatasetCandlesAsync } from '../historical/historicalDataService.js';
import { sanitizeJson } from '../historical/jsonSafety.js';
import { findCompatibleDatasetsForSymbols, loadCandlesFromMultipleDatasets } from '../services/dataRequirementService.js';

const macroRoutes = Router();

// ── Annualisation factors (trading periods per year per timeframe) ──────────
const ANN_FACTOR = {
  '1m': 252 * 390, '5m': 252 * 78, '15m': 252 * 26,
  '30m': 252 * 13, '1h': 252 * 6.5, '4h': 252 * 1.625,
  '1d': 252, '1w': 52,
};

// ── Parsing helpers ────────────────────────────────────────────────────────────

function parseSymbols(raw) {
  return raw
    ? String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
        .filter((s, i, arr) => arr.indexOf(s) === i)
    : undefined;
}

function parseWindow(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseDatasetIds(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : null;
}

function closeOf(candle) {
  const close = Number(candle.close ?? candle.c);
  return Number.isFinite(close) && close > 0 ? close : null;
}

function timeOf(candle) {
  const ts = Number(candle.timestamp ?? candle.t);
  return Number.isFinite(ts) ? String(ts) : null;
}

// ── Numerical helpers ──────────────────────────────────────────────────────────

function stdDev(arr) {
  if (!arr || arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (arr.length - 1);
  return Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : null;
}

function realizedVolatility(vals, timeframe) {
  const annFactor = ANN_FACTOR[timeframe] ?? 252;
  const std = stdDev(vals);
  return std != null ? std * Math.sqrt(annFactor) : null;
}

// ── Return series helpers ──────────────────────────────────────────────────────

/**
 * Group candles by symbol, compute simple returns keyed by timestamp string.
 * Returns Map<symbol, Map<timeStr, returnValue>>.
 */
function groupedReturns(candles, symbols) {
  const grouped = new Map(symbols.map((symbol) => [symbol, []]));
  for (const candle of candles || []) {
    const symbol = String(candle.symbol || '').toUpperCase();
    if (!grouped.has(symbol)) continue;
    const time = timeOf(candle);
    const close = closeOf(candle);
    if (!time || close == null) continue;
    grouped.get(symbol).push({ time, close });
  }
  const returnsBySymbol = new Map();
  for (const [symbol, rows] of grouped) {
    rows.sort((a, b) => Number(a.time) - Number(b.time));
    const returns = new Map();
    for (let i = 1; i < rows.length; i += 1) {
      const prev = rows[i - 1].close;
      const next = rows[i].close;
      if (prev > 0 && Number.isFinite(next)) returns.set(rows[i].time, (next - prev) / prev);
    }
    returnsBySymbol.set(symbol, returns);
  }
  return returnsBySymbol;
}

/**
 * Get sorted close array for a symbol from candles.
 */
function closeSeries(candles, symbol) {
  return (candles || [])
    .filter((c) => String(c.symbol || '').toUpperCase() === symbol)
    .sort((a, b) => Number(a.timestamp ?? a.t ?? 0) - Number(b.timestamp ?? b.t ?? 0))
    .map((c) => closeOf(c))
    .filter((v) => v != null);
}

/**
 * Align two return Maps by timestamp; returns array of [a, b] pairs.
 */
function alignedPairs(aReturns, bReturns) {
  const pairs = [];
  for (const [time, a] of aReturns) {
    const b = bReturns.get(time);
    if (Number.isFinite(a) && Number.isFinite(b)) pairs.push([a, b]);
  }
  return pairs;
}

// ── Correlation / Beta calculations ───────────────────────────────────────────

function correlationFromPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 2) return null;
  const n = pairs.length;
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / n;
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (const [a, b] of pairs) {
    const da = a - meanA;
    const db = b - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  if (!Number.isFinite(denom) || denom === 0) return null;
  const corr = cov / denom;
  return Number.isFinite(corr) ? Math.max(-1, Math.min(1, corr)) : null;
}

function betaFromPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length < 2) return { beta: null, r2: null };
  const n = pairs.length;
  const meanAsset = pairs.reduce((sum, pair) => sum + pair[0], 0) / n;
  const meanBench = pairs.reduce((sum, pair) => sum + pair[1], 0) / n;
  let cov = 0, benchVar = 0;
  for (const [asset, bench] of pairs) {
    cov += (asset - meanAsset) * (bench - meanBench);
    benchVar += (bench - meanBench) ** 2;
  }
  const beta = benchVar > 0 ? cov / benchVar : null;
  const corr = correlationFromPairs(pairs);
  return {
    beta: Number.isFinite(beta) ? beta : null,
    r2:   Number.isFinite(corr) ? corr ** 2 : null,
  };
}

// ── Dataset loading helper ────────────────────────────────────────────────────

async function datasetCandlesResponse(datasetId, res) {
  const read = await readDatasetCandlesAsync(datasetId);
  if (!read.ok) {
    const status = read.error === 'dataset_not_found' ? 404 : 200;
    return {
      done: true,
      response: res.status(status).json(sanitizeJson({
        ok: false,
        status: read.error,
        error: read.error,
        message: read.error === 'dataset_not_found'
          ? 'Historical dataset not found.'
          : 'Historical dataset exists but no usable CSV/Parquet file was found.',
        datasetId,
      })),
    };
  }
  return { done: false, candles: read.candles, dataset: read.dataset };
}

/**
 * After computing groupedReturns, detect which requested symbols have no data.
 * Returns { missing: string[], available: string[] }.
 */
function detectMissingSymbols(returnsBySymbol, requestedSymbols) {
  const missing = requestedSymbols.filter((sym) => {
    const r = returnsBySymbol.get(sym);
    return !r || r.size === 0;
  });
  return { missing, available: requestedSymbols.filter((sym) => !missing.includes(sym)) };
}

/**
 * Load candles for the requested symbols from one or more datasets.
 * Supports three input modes:
 *   a) explicit datasetIds array → load each dataset, merge candles
 *   b) single datasetId → try primary, auto-resolve missing symbols via registry
 *   c) no dataset → return "not_enough_data"
 *
 * Returns:
 *   { done: true, response }  when a terminal HTTP response was already sent
 *   { done: false, candles, datasetsBySymbol, resolution, stillMissing }
 */
async function resolveAndLoadCandles(primaryDatasetId, datasetIds, symbols, res) {
  const datasetsBySymbol = {};
  let candles = [];
  let resolution = 'single_dataset';

  // ── Case A: explicit multi-dataset IDs ──────────────────────────────────────
  if (datasetIds && datasetIds.length > 0) {
    for (const dsId of datasetIds) {
      const result = await readDatasetCandlesAsync(dsId);
      if (!result.ok) continue;
      for (const c of result.candles) {
        const sym = String(c.symbol || '').toUpperCase();
        if (symbols.includes(sym) && !datasetsBySymbol[sym]) {
          datasetsBySymbol[sym] = dsId;
        }
      }
      candles = candles.concat(result.candles);
    }
    resolution = datasetIds.length > 1 ? 'multi_dataset' : 'single_dataset';
    if (candles.length === 0) {
      return {
        done: true,
        response: res.status(200).json(sanitizeJson({
          ok: false, status: 'dataset_not_found',
          message: 'None of the specified datasets could be loaded.',
          datasetIds,
        })),
      };
    }
    return { done: false, candles, datasetsBySymbol, resolution, stillMissing: [] };
  }

  // ── Case B: single datasetId with auto-resolution ────────────────────────────
  if (primaryDatasetId) {
    const primaryResult = await readDatasetCandlesAsync(primaryDatasetId);
    if (!primaryResult.ok) {
      const status = primaryResult.error === 'dataset_not_found' ? 404 : 200;
      return {
        done: true,
        response: res.status(status).json(sanitizeJson({
          ok: false,
          status: primaryResult.error,
          error: primaryResult.error,
          message: primaryResult.error === 'dataset_not_found'
            ? 'Historical dataset not found.'
            : 'Historical dataset exists but no usable CSV/Parquet file was found.',
          datasetId: primaryDatasetId,
        })),
      };
    }

    candles = primaryResult.candles;

    // Which symbols are present in the primary dataset?
    const primaryReturns = groupedReturns(candles, symbols);
    const { missing, available } = detectMissingSymbols(primaryReturns, symbols);
    for (const sym of available) datasetsBySymbol[sym] = primaryDatasetId;

    if (missing.length === 0) {
      return { done: false, candles, datasetsBySymbol, resolution: 'single_dataset', stillMissing: [] };
    }

    // Auto-resolve missing symbols from the registry
    const { datasetsBySymbol: found, missingSymbols: stillMissing } =
      findCompatibleDatasetsForSymbols({
        symbols: missing,
        timeframe: primaryResult.dataset?.timeframe,
      });

    if (Object.keys(found).length > 0) {
      const { candles: extraCandles } = await loadCandlesFromMultipleDatasets(found);
      candles = candles.concat(extraCandles);
      Object.assign(datasetsBySymbol, found);
      resolution = 'multi_dataset';
    }

    return { done: false, candles, datasetsBySymbol, resolution, stillMissing: stillMissing || [] };
  }

  // ── Case C: no dataset ────────────────────────────────────────────────────────
  return { done: false, candles: [], datasetsBySymbol: {}, resolution: 'none', stillMissing: symbols };
}

// ── Routes ────────────────────────────────────────────────────────────────────

macroRoutes.get('/correlation', async (req, res) => {
  const datasetId  = req.query.datasetId  ? String(req.query.datasetId)  : null;
  const datasetIds = parseDatasetIds(req.query.datasetIds);
  const symbols    = parseSymbols(req.query.symbols) || ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'];
  const timeframe  = req.query.timeframe || '1d';
  const window     = parseWindow(req.query.window) ?? 20;

  if (!datasetId && !datasetIds) {
    return res.status(200).json({ ok: true, symbols, matrix: [], observations: 0, timeframe, window, status: 'not_enough_data', message: 'Select a dataset to compute correlation.' });
  }

  const loaded = await resolveAndLoadCandles(datasetId, datasetIds, symbols, res);
  if (loaded.done) return loaded.response;

  const returns = groupedReturns(loaded.candles, symbols);
  const { missing, available } = detectMissingSymbols(returns, symbols);

  if (missing.length > 0) {
    return res.status(200).json(sanitizeJson({
      ok: false,
      status: 'missing_symbols',
      message: `No compatible dataset found for: ${missing.join(', ')}.`,
      datasetId,
      requestedSymbols: symbols,
      availableSymbols: available,
      missingSymbols: missing,
      action: 'create_dataset',
    }));
  }

  const matrix = symbols.map((a) => symbols.map((b) => {
    if (a === b) return 1;
    return correlationFromPairs(alignedPairs(returns.get(a) || new Map(), returns.get(b) || new Map()));
  }));

  const observations = symbols.length >= 2
    ? alignedPairs(returns.get(symbols[0]) || new Map(), returns.get(symbols[1]) || new Map()).length
    : 0;

  if (observations < 2) {
    return res.status(200).json(sanitizeJson({
      ok: true, datasetId, datasetIds, symbols, matrix: [], observations, timeframe, window,
      status: 'not_enough_data', message: 'Not enough overlapping observations.',
      resolution: loaded.resolution, datasetsBySymbol: loaded.datasetsBySymbol,
      overlapStart: null, overlapEnd: null, requiredRows: window,
    }));
  }

  const pairs = [];
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const c = matrix[i][j];
      if (c != null) pairs.push({ x: symbols[i], y: symbols[j], correlation: c });
    }
  }

  return res.status(200).json(sanitizeJson({
    ok: true, datasetId, symbols, matrix, pairs, observations, timeframe, window,
    status: 'ready', resolution: loaded.resolution, datasetsBySymbol: loaded.datasetsBySymbol,
  }));
});

macroRoutes.get('/beta', async (req, res) => {
  const datasetId  = req.query.datasetId  ? String(req.query.datasetId)  : null;
  const datasetIds = parseDatasetIds(req.query.datasetIds);
  const asset      = String(req.query.asset || req.query.symbol || 'QQQ').toUpperCase();
  const benchmark  = String(req.query.benchmark || 'SPY').toUpperCase();
  const timeframe  = req.query.timeframe || '1d';
  const window     = parseWindow(req.query.window) ?? 20;
  const symbols    = [asset, benchmark];

  if (!datasetId && !datasetIds) {
    return res.status(200).json({ ok: true, asset, benchmark, beta: null, r2: null, observations: 0, timeframe, window, status: 'not_enough_data', message: 'Select a dataset to compute beta.' });
  }

  const loaded = await resolveAndLoadCandles(datasetId, datasetIds, symbols, res);
  if (loaded.done) return loaded.response;

  const returns = groupedReturns(loaded.candles, symbols);
  const { missing, available } = detectMissingSymbols(returns, symbols);

  if (missing.length > 0) {
    return res.status(200).json(sanitizeJson({
      ok: false,
      status: 'missing_symbols',
      message: `No compatible dataset found for: ${missing.join(', ')}.`,
      datasetId,
      requestedSymbols: symbols,
      availableSymbols: available,
      missingSymbols: missing,
      action: 'create_dataset',
    }));
  }

  const pairs = alignedPairs(returns.get(asset) || new Map(), returns.get(benchmark) || new Map());
  const { beta, r2 } = betaFromPairs(pairs);

  if (pairs.length < 2 || beta === null || r2 === null) {
    return res.status(200).json(sanitizeJson({
      ok: true, datasetId, asset, benchmark, beta: null, r2: null,
      observations: pairs.length, timeframe, window, status: 'not_enough_data',
      message: 'Not enough overlapping observations.',
      resolution: loaded.resolution, datasetsBySymbol: loaded.datasetsBySymbol,
    }));
  }

  return res.status(200).json(sanitizeJson({
    ok: true, datasetId, asset, benchmark, beta, r2,
    observations: pairs.length, timeframe, window, status: 'ready',
    resolution: loaded.resolution, datasetsBySymbol: loaded.datasetsBySymbol,
  }));
});

macroRoutes.get('/sector-rotation', (req, res) => {
  const timeframe = req.query.timeframe || '1d';
  const window    = parseWindow(req.query.window) ?? 20;
  const benchmark = String(req.query.benchmark || 'SPY').toUpperCase();
  const symbols   = parseSymbols(req.query.symbols) || [];
  return res.status(200).json(sanitizeJson({
    ok: true,
    status: 'not_available',
    reason: 'sector_metadata_missing',
    message: 'Sector rotation requires sector classification metadata for the requested symbols.',
    symbols,
    benchmark,
    timeframe,
    window,
    sectors: [],
  }));
});

macroRoutes.get('/volatility-heatmap', async (req, res) => {
  const datasetId = req.query.datasetId ? String(req.query.datasetId) : null;
  const symbols   = parseSymbols(req.query.symbols) || ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'];
  const timeframe = req.query.timeframe || '1d';
  const window    = parseWindow(req.query.window) ?? 20;

  if (!datasetId) {
    return res.status(200).json({ ok: true, symbols, items: [], timeframe, window, status: 'not_enough_data', message: 'Select a dataset to compute volatility.' });
  }

  const loaded = await datasetCandlesResponse(datasetId, res);
  if (loaded.done) return loaded.response;

  const returns = groupedReturns(loaded.candles, symbols);

  const { missing, available } = detectMissingSymbols(returns, symbols);
  if (missing.length > 0) {
    return res.status(200).json(sanitizeJson({
      ok: false,
      status: 'missing_symbols',
      message: `Dataset does not contain all requested symbols.`,
      datasetId,
      requestedSymbols: symbols,
      availableSymbols: available,
      missingSymbols:   missing,
    }));
  }

  const items = symbols.map((sym) => {
    const symReturns  = returns.get(sym);
    const vals        = symReturns ? [...symReturns.values()] : [];
    const vol         = realizedVolatility(vals, timeframe);
    const closes      = closeSeries(loaded.candles, sym);
    const firstClose  = closes.length > 0 ? closes[0] : null;
    const lastClose   = closes.length > 0 ? closes[closes.length - 1] : null;
    const totalReturn = firstClose && lastClose ? (lastClose - firstClose) / firstClose : null;
    return {
      symbol:      sym,
      realizedVol: vol != null ? Number(vol.toFixed(4)) : null,
      return:      totalReturn != null ? Number(totalReturn.toFixed(4)) : null,
      observations: vals.length + 1,
    };
  });

  const minObs = items.reduce((m, i) => Math.min(m, i.observations), Infinity);

  if (items.some((item) => item.realizedVol == null)) {
    return res.status(200).json(sanitizeJson({ ok: true, datasetId, symbols, items, status: 'not_enough_data', message: 'Insufficient data for one or more symbols.', timeframe, window }));
  }

  return res.status(200).json(sanitizeJson({ ok: true, datasetId, symbols, items, status: 'ready', timeframe, window, observations: minObs }));
});

macroRoutes.use((req, res) => {
  return res.status(404).json({ ok: false, status: 'not_found', error: 'Macro endpoint not found', endpoint: req.originalUrl || req.path });
});

export default macroRoutes;
export { correlationFromPairs, betaFromPairs, groupedReturns };
