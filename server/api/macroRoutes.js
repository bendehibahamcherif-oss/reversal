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

const DATE_COLUMN_CANDIDATES = ['date', 'timestamp', 'datetime', 'time'];
const CLOSE_COLUMN_BASE_CANDIDATES = ['close', 'adjClose', 'Adj Close', 'adjusted_close', 'price', 'last', 'c'];

function parseSymbols(raw) {
  return raw
    ? String(raw).split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)
        .filter((value, index, array) => array.indexOf(value) === index)
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

function normalizeColumnName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function columnCandidatesForClose(symbol) {
  const sym = String(symbol || '').trim();
  return [
    ...CLOSE_COLUMN_BASE_CANDIDATES,
    ...(sym ? [`close_${sym}`, `${sym}_close`] : []),
  ];
}

function findColumnKey(row, candidates) {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.keys(row).map((key) => [key, normalizeColumnName(key)]);
  const normalizedCandidates = candidates.map((key) => normalizeColumnName(key));
  for (const candidate of normalizedCandidates) {
    const found = entries.find(([, normalized]) => normalized === candidate);
    if (found) return found[0];
  }
  return null;
}

function detectDateColumn(candle) {
  return findColumnKey(candle, DATE_COLUMN_CANDIDATES);
}

function detectCloseColumn(candle, symbol) {
  return findColumnKey(candle, columnCandidatesForClose(symbol));
}

function normalizeDateKey(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    if (raw > 1e9) {
      const ms = raw > 1e12 ? raw : raw * 1000;
      const parsed = new Date(ms);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
    }
    return String(raw);
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const datetimePrefix = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (datetimePrefix) return datetimePrefix[1];
  const numeric = Number(s);
  if (Number.isFinite(numeric) && numeric > 1e9) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = new Date(ms);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function closeOf(candle, symbol) {
  const closeCol = detectCloseColumn(candle, symbol);
  const close = Number(closeCol ? candle[closeCol] : undefined);
  return Number.isFinite(close) && close > 0 ? close : null;
}

/**
 * Extract a canonical daily time key from a candle for return alignment.
 */
function timeOf(candle) {
  const dateCol = detectDateColumn(candle);
  return normalizeDateKey(dateCol ? candle[dateCol] : null);
}

/** Infer ticker symbol from datasetId pattern: hist_SYMBOL_... */
function inferSymbolFromDatasetId(datasetId) {
  const m = String(datasetId || '').match(/^hist_([A-Z0-9^.]+)_/i);
  return m ? m[1].toUpperCase() : null;
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
    const close = closeOf(candle, symbol);
    if (!time || close == null) continue;
    grouped.get(symbol).push({ time, close });
  }
  const returnsBySymbol = new Map();
  for (const [symbol, rows] of grouped) {
    rows.sort((a, b) => String(a.time).localeCompare(String(b.time)));
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
    .sort((a, b) => String(timeOf(a) || '').localeCompare(String(timeOf(b) || '')))
    .map((c) => closeOf(c, symbol))
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

function analyzeParsedSeries(candles, symbols) {
  const bySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  for (const candle of candles || []) {
    const symbol = String(candle.symbol || '').toUpperCase();
    if (bySymbol[symbol]) bySymbol[symbol].push(candle);
  }
  const parsedSeries = {};
  for (const symbol of symbols) {
    const rows = bySymbol[symbol] || [];
    const dateColumn = rows.map(detectDateColumn).find(Boolean) || null;
    const closeColumn = rows.map((row) => detectCloseColumn(row, symbol)).find(Boolean) || null;
    const parsed = rows.map((row) => ({ date: timeOf(row), close: closeOf(row, symbol) }));
    const valid = parsed.filter((row) => row.date && Number.isFinite(row.close));
    const dates = valid.map((row) => row.date).sort((a, b) => String(a).localeCompare(String(b)));
    parsedSeries[symbol] = {
      rawRows: rows.length,
      parsedRows: valid.length,
      dateColumn,
      closeColumn,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      sampleDates: dates.slice(0, 5),
      invalidDateRows: parsed.filter((row) => !row.date).length,
      invalidCloseRows: parsed.filter((row) => !Number.isFinite(row.close)).length,
    };
  }
  return parsedSeries;
}

function commonReturnDates(returns, symbols) {
  if (!symbols.length) return [];
  let common = new Set([...(returns.get(symbols[0]) || new Map()).keys()]);
  for (const symbol of symbols.slice(1)) {
    const keys = new Set([...(returns.get(symbol) || new Map()).keys()]);
    common = new Set([...common].filter((date) => keys.has(date)));
  }
  return [...common].sort((a, b) => String(a).localeCompare(String(b)));
}

function rootCauseForZeroAlignment(parsedSeries, commonDatesCount) {
  const entries = Object.entries(parsedSeries || {});
  if (entries.some(([, diag]) => diag.rawRows === 0)) return 'dataset_file_missing';
  if (entries.some(([, diag]) => !diag.dateColumn)) return 'no_date_column';
  if (entries.some(([, diag]) => !diag.closeColumn)) return 'no_close_column';
  if (entries.some(([, diag]) => diag.parsedRows === 0 && diag.invalidDateRows > 0)) return 'parsed_dates_format_mismatch';
  if (entries.some(([, diag]) => diag.parsedRows === 0 && diag.invalidCloseRows > 0)) return 'close_values_invalid';
  if (commonDatesCount === 0) return 'no_overlap';
  return 'returns_computed_using_different_date_keys';
}

function zeroAlignmentDiagnostics({ symbols, datasetIds, datasetsBySymbol, candles, returns, loadDiagnostics }) {
  const parsedSeriesBySymbol = analyzeParsedSeries(candles, symbols);
  const parsedSeries = symbols.map((symbol) => {
    const returnMap = returns.get(symbol) || new Map();
    const returnDates = [...returnMap.keys()].sort();
    return {
      symbol,
      returnCount: returnMap.size,
      firstDate: returnDates[0] ?? parsedSeriesBySymbol[symbol]?.firstDate ?? null,
      lastDate: returnDates[returnDates.length - 1] ?? parsedSeriesBySymbol[symbol]?.lastDate ?? null,
      ...parsedSeriesBySymbol[symbol],
    };
  });
  const dates = commonReturnDates(returns, symbols);
  const rootCause = rootCauseForZeroAlignment(parsedSeriesBySymbol, dates.length);
  return {
    reason: rootCause,
    requestedSymbols: symbols,
    datasetIds: datasetIds || [],
    datasetsBySymbol,
    parsedSeries,
    parsedSeriesBySymbol,
    commonDatesCount: dates.length,
    commonDatesPreview: [...dates.slice(0, 10), ...dates.slice(-10)].filter((value, index, array) => array.indexOf(value) === index),
    loadDiagnostics: loadDiagnostics || [],
    rootCause,
  };
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
async function resolveAndLoadCandles(primaryDatasetId, datasetIds, symbols, res, options = {}) {
  const datasetOrderSymbols = Array.isArray(options.datasetOrderSymbols) && options.datasetOrderSymbols.length
    ? options.datasetOrderSymbols
    : symbols;
  const datasetsBySymbol = {};
  let candles = [];
  let resolution = 'single_dataset';

  // ── Case A: explicit multi-dataset IDs ──────────────────────────────────────
  if (datasetIds && datasetIds.length > 0) {
    const loadDiagnostics = [];
    for (let idx = 0; idx < datasetIds.length; idx++) {
      const dsId = datasetIds[idx];
      const result = await readDatasetCandlesAsync(dsId);
      const diag = { datasetId: dsId, ok: result.ok, error: result.error ?? null, rawCount: 0, parsedCount: 0, inferredSymbol: null };
      if (!result.ok) { loadDiagnostics.push(diag); continue; }

      // Explicit datasetIds are mapped positionally to the requested symbols first.
      const registrySymbol = (datasetOrderSymbols[idx] ? datasetOrderSymbols[idx].toUpperCase() : '') ||
        (result.dataset?.symbol || '').toUpperCase() ||
        (Array.isArray(result.dataset?.symbols) && result.dataset.symbols[0]
          ? String(result.dataset.symbols[0]).toUpperCase() : '') ||
        inferSymbolFromDatasetId(dsId) ||
        (symbols[idx] ? symbols[idx].toUpperCase() : '');

      diag.inferredSymbol = registrySymbol || null;
      diag.rawCount = result.candles.length;

      // Inject symbol into candles that lack it so groupedReturns can bucket them
      const patched = result.candles.map((c) => {
        const sym = String(c.symbol || '').toUpperCase();
        if (registrySymbol && (!sym || !symbols.includes(sym))) return { ...c, symbol: registrySymbol };
        return c;
      });
      for (const c of patched) {
        const sym = String(c.symbol || '').toUpperCase();
        if (symbols.includes(sym) && !datasetsBySymbol[sym]) datasetsBySymbol[sym] = dsId;
      }
      diag.parsedCount = patched.filter((c) => String(c.symbol || '').toUpperCase()).length;
      loadDiagnostics.push(diag);
      candles = candles.concat(patched);
    }
    resolution = datasetIds.length > 1 ? 'multi_dataset' : 'single_dataset';
    if (candles.length === 0) {
      return {
        done: true,
        response: res.status(200).json(sanitizeJson({
          ok: false, status: 'dataset_not_found', reason: 'dataset_not_found', alignedRows: 0,
          message: 'None of the specified datasets could be loaded.',
          datasetIds, diagnostics: { loadDiagnostics, rootCause: 'dataset_not_found' },
        })),
      };
    }
    return { done: false, candles, datasetsBySymbol, resolution, stillMissing: [], loadDiagnostics };
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
          reason: primaryResult.error,
          alignedRows: 0,
          error: primaryResult.error,
          message: primaryResult.error === 'dataset_not_found'
            ? 'Historical dataset not found.'
            : 'Historical dataset exists but no usable CSV/Parquet file was found.',
          datasetId: primaryDatasetId,
          diagnostics: { rootCause: primaryResult.error },
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

  const loaded = await resolveAndLoadCandles(datasetId, datasetIds, symbols, res, { datasetOrderSymbols: symbols });
  if (loaded.done) return loaded.response;

  const returns = groupedReturns(loaded.candles, symbols);
  const { missing, available } = detectMissingSymbols(returns, symbols);

  if (missing.length > 0) {
    const diagnostics = zeroAlignmentDiagnostics({
      symbols, datasetIds, datasetsBySymbol: loaded.datasetsBySymbol,
      candles: loaded.candles, returns, loadDiagnostics: loaded.loadDiagnostics,
    });
    return res.status(200).json(sanitizeJson({
      ok: false,
      status: 'missing_symbols',
      reason: diagnostics.rootCause === 'no_close_column' ? 'no_close_column' : 'dataset_parse_failed',
      alignedRows: 0,
      message: `No compatible dataset found for: ${missing.join(', ')}.`,
      datasetId, datasetIds,
      requestedSymbols: symbols,
      availableSymbols: available,
      missingSymbols: missing,
      action: 'create_dataset',
      diagnostics,
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
    // Build structured diagnostics so the caller knows why overlap is 0
    const parsedSeries = symbols.map((sym) => {
      const r = returns.get(sym) || new Map();
      const dates = [...r.keys()].sort();
      return { symbol: sym, returnCount: r.size, firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null };
    });
    const reason = parsedSeries.every((s) => s.returnCount === 0)
      ? 'no_returns_parsed'
      : parsedSeries.some((s) => s.returnCount === 0)
        ? 'one_series_empty'
        : 'no_overlap';
    const diagnostics = zeroAlignmentDiagnostics({
      symbols, datasetIds, datasetsBySymbol: loaded.datasetsBySymbol,
      candles: loaded.candles, returns, loadDiagnostics: loaded.loadDiagnostics,
    });
    return res.status(200).json(sanitizeJson({
      ok: observations > 0, datasetId, datasetIds, symbols, matrix: [], observations, alignedRows: observations, timeframe, window,
      status: 'not_enough_data', reason: diagnostics.rootCause, message: 'Not enough overlapping observations.',
      resolution: loaded.resolution, datasetsBySymbol: loaded.datasetsBySymbol,
      requiredRows: window,
      diagnostics,
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
    ok: true, datasetId, datasetIds, symbols, matrix, pairs, observations, alignedRows: observations, timeframe, window,
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
  const requestedSymbols = parseSymbols(req.query.symbols);
  const symbols    = [asset, benchmark].filter((value, index, array) => array.indexOf(value) === index);
  const datasetOrderSymbols = requestedSymbols || [benchmark, asset].filter((value, index, array) => array.indexOf(value) === index);

  if (!datasetId && !datasetIds) {
    return res.status(200).json({ ok: true, asset, benchmark, beta: null, r2: null, observations: 0, timeframe, window, status: 'not_enough_data', message: 'Select a dataset to compute beta.' });
  }

  const loaded = await resolveAndLoadCandles(datasetId, datasetIds, symbols, res, { datasetOrderSymbols });
  if (loaded.done) return loaded.response;

  const returns = groupedReturns(loaded.candles, symbols);
  const { missing, available } = detectMissingSymbols(returns, symbols);

  if (missing.length > 0) {
    const diagnostics = zeroAlignmentDiagnostics({
      symbols, datasetIds, datasetsBySymbol: loaded.datasetsBySymbol,
      candles: loaded.candles, returns, loadDiagnostics: loaded.loadDiagnostics,
    });
    return res.status(200).json(sanitizeJson({
      ok: false,
      status: 'missing_symbols',
      reason: diagnostics.rootCause === 'no_close_column' ? 'no_close_column' : 'dataset_parse_failed',
      alignedRows: 0,
      message: `No compatible dataset found for: ${missing.join(', ')}.`,
      datasetId, datasetIds,
      requestedSymbols: symbols,
      availableSymbols: available,
      missingSymbols: missing,
      action: 'create_dataset',
      diagnostics,
    }));
  }

  const pairs = alignedPairs(returns.get(asset) || new Map(), returns.get(benchmark) || new Map());
  const { beta, r2 } = betaFromPairs(pairs);

  if (pairs.length < 2 || beta === null || r2 === null) {
    const diagnostics = zeroAlignmentDiagnostics({
      symbols, datasetIds, datasetsBySymbol: loaded.datasetsBySymbol,
      candles: loaded.candles, returns, loadDiagnostics: loaded.loadDiagnostics,
    });
    return res.status(200).json(sanitizeJson({
      ok: false, datasetId, datasetIds, asset, benchmark, beta: null, r2: null,
      observations: pairs.length, alignedRows: pairs.length, timeframe, window, status: 'not_enough_data',
      reason: diagnostics.rootCause, message: 'Not enough overlapping observations.',
      resolution: loaded.resolution, datasetsBySymbol: loaded.datasetsBySymbol, diagnostics,
    }));
  }

  return res.status(200).json(sanitizeJson({
    ok: true, datasetId, datasetIds, asset, benchmark, beta, r2,
    observations: pairs.length, alignedRows: pairs.length, timeframe, window, status: 'ready',
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
