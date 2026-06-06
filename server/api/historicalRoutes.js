import { Router } from 'express';
import {
  downloadHistoricalDataset,
  readDatasetCandlesAsync,
  listDatasets,
  getDataset,
  deleteDataset,
  listProviderCapabilities,
  resolveDatasetForTraining,
  diagnoseDataset,
} from '../historical/historicalDataService.js';
import { sanitizeJson } from '../historical/jsonSafety.js';

const historicalRoutes = Router();

const SYMBOL_REQUIRED_RESPONSE = {
  ok: false,
  status: 'symbol_required',
  message: 'At least one symbol is required.',
  expected: {
    symbols: ['SPY', 'QQQ'],
  },
};

export function normalizeHistoricalDownloadSymbols(body = {}) {
  const rawSymbols = Object.hasOwn(body, 'symbols') ? body.symbols : body.symbol;
  const values = Array.isArray(rawSymbols)
    ? rawSymbols
    : typeof rawSymbols === 'string'
      ? rawSymbols.split(',')
      : rawSymbols == null
        ? []
        : [rawSymbols];

  return values
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function sendJson(res, statusCode, payload) {
  return res.status(statusCode).json(sanitizeJson(payload));
}

function symbolRequired(res) {
  return sendJson(res, 400, SYMBOL_REQUIRED_RESPONSE);
}

function datasetNotFound(res, datasetId) {
  return sendJson(res, 404, {
    ok: false,
    status: 'dataset_not_found',
    message: 'Historical dataset not found.',
    datasetId,
  });
}

// GET /api/historical/providers
historicalRoutes.get('/providers', (_req, res) => {
  return sendJson(res, 200, { ok: true, providers: listProviderCapabilities() });
});

// GET /api/historical/datasets
historicalRoutes.get('/datasets', (req, res) => {
  const { symbol, timeframe, provider, purpose } = req.query;
  const datasets = listDatasets({ symbol, timeframe, provider, purpose });
  return sendJson(res, 200, { ok: true, datasets, count: datasets.length });
});

// GET /api/historical/datasets/:id
historicalRoutes.get('/datasets/:id', (req, res) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return datasetNotFound(res, req.params.id);
  return sendJson(res, 200, { ok: true, dataset });
});

// GET /api/historical/datasets/:id/diagnostics
// Full ML-readiness diagnostic for a dataset.
historicalRoutes.get('/datasets/:id/diagnostics', (req, res) => {
  const diag = diagnoseDataset(req.params.id);
  if (!diag.registryFound) {
    return sendJson(res, 404, { ...diag, ok: false });
  }
  return sendJson(res, 200, diag);
});

// GET /api/historical/datasets/:id/candles
historicalRoutes.get('/datasets/:id/candles', async (req, res) => {
  const result = await readDatasetCandlesAsync(req.params.id);
  if (!result.ok) {
    const status = result.error === 'dataset_not_found' ? 404 : 500;
    return sendJson(res, status, { ok: false, status: result.error, error: result.error, datasetId: req.params.id });
  }
  const { candles, meta, dataset } = result;
  const limit  = req.query.limit  ? Math.min(50000, parseInt(req.query.limit, 10))  : candles.length;
  const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset, 10)) : 0;
  const slice  = candles.slice(offset, offset + limit);
  return sendJson(res, 200, { ok: true, candles: slice, count: slice.length, total: candles.length, meta, dataset });
});

// POST /api/historical/download
// Canonical body: { symbols, timeframe, provider, startDate, endDate, limit, purpose, credentials }
// Backward compatibility: { symbol } is accepted and normalized to symbols: [symbol].
historicalRoutes.post('/download', async (req, res) => {
  const {
    timeframe  = '1d',
    provider   = 'yahoo',
    startDate,
    endDate,
    limit,
    purpose    = 'general',
    credentials,
  } = req.body || {};

  const symbols = normalizeHistoricalDownloadSymbols(req.body || {});

  if (!symbols.length) {
    return symbolRequired(res);
  }

  const VALID_PROVIDERS = ['yahoo', 'twelvedata', 'polygon', 'alphaVantage'];
  if (!VALID_PROVIDERS.includes(provider)) {
    return sendJson(res, 400, { ok: false, status: 'invalid_provider', error: `invalid_provider. Supported: ${VALID_PROVIDERS.join(', ')}` });
  }

  const VALID_PURPOSES = ['general', 'ml', 'backtest', 'correlation'];
  if (!VALID_PURPOSES.includes(purpose)) {
    return sendJson(res, 400, { ok: false, status: 'invalid_purpose', error: `invalid_purpose. Supported: ${VALID_PURPOSES.join(', ')}` });
  }

  try {
    const results = [];
    for (const symbol of symbols) {
      const result = await downloadHistoricalDataset({
        symbol,
        symbols: [symbol],
        timeframe,
        provider,
        startDate,
        endDate,
        limit,
        purpose,
        credentials,
        session: req.body?.session || 'RTH',
      });
      results.push({ symbol, ...result });
    }

    const failed = results.find((result) => !result.ok);
    if (failed) {
      return sendJson(res, 422, {
        ok: false,
        error: failed.error,
        status: failed.error,
        symbol: failed.symbol,
        detail: failed.detail,
        warnings: failed.warnings,
        results,
      });
    }

    const datasets = results.map((result) => result.dataset);
    const candleCount = results.reduce((total, result) => total + (result.candleCount || 0), 0);
    const skipped = results.reduce((total, result) => total + (result.skipped || 0), 0);
    const warnings = results.flatMap((result) => result.warnings ?? []);

    return sendJson(res, 200, {
      ok:         true,
      symbols,
      dataset:    datasets[0] ?? null,
      datasets,
      candleCount,
      skipped,
      warnings,
    });
  } catch (err) {
    return sendJson(res, 500, { ok: false, status: 'historical_download_failed', error: err.message, message: err.message });
  }
});

// DELETE /api/historical/datasets/:id
historicalRoutes.delete('/datasets/:id', async (req, res) => {
  try {
    const result = await deleteDataset(req.params.id);
    if (!result.ok) return datasetNotFound(res, req.params.id);
    return sendJson(res, 200, { ok: true, deleted: req.params.id });
  } catch (err) {
    return sendJson(res, 500, { ok: false, status: 'historical_delete_failed', error: err.message, message: err.message });
  }
});

// GET /api/historical/status
historicalRoutes.get('/status', (_req, res) => {
  const datasets = listDatasets();
  return sendJson(res, 200, {
    ok:           true,
    service:      'historical-data',
    datasetCount: datasets.length,
    readyCount:   datasets.filter((d) => d.status === 'ready').length,
    providers:    listProviderCapabilities().map((p) => ({
      id:                  p.id,
      name:                p.name,
      requiresCredentials: p.requiresCredentials,
      timeframes:          p.timeframes,
    })),
  });
});

export default historicalRoutes;
