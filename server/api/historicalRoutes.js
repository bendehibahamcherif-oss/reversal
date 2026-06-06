import { Router } from 'express';
import {
  downloadHistoricalDataset,
  readDatasetCandlesAsync,
  listDatasets,
  getDataset,
  deleteDataset,
  listProviderCapabilities,
} from '../historical/historicalDataService.js';

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
    .filter(Boolean);
}

function symbolRequired(res) {
  return res.status(400).json(SYMBOL_REQUIRED_RESPONSE);
}

// GET /api/historical/providers
// List all supported providers with their capability matrix.
historicalRoutes.get('/providers', (_req, res) => {
  return res.json({ ok: true, providers: listProviderCapabilities() });
});

// GET /api/historical/datasets
// List stored datasets. Query: symbol, timeframe, provider, purpose.
historicalRoutes.get('/datasets', (req, res) => {
  const { symbol, timeframe, provider, purpose } = req.query;
  const datasets = listDatasets({ symbol, timeframe, provider, purpose });
  return res.json({ ok: true, datasets, count: datasets.length });
});

// GET /api/historical/datasets/:id
// Get a single dataset record.
historicalRoutes.get('/datasets/:id', (req, res) => {
  const dataset = getDataset(req.params.id);
  if (!dataset) return res.status(404).json({ ok: false, error: 'dataset_not_found' });
  return res.json({ ok: true, dataset });
});

// GET /api/historical/datasets/:id/candles
// Stream candles from a stored dataset.
historicalRoutes.get('/datasets/:id/candles', async (req, res) => {
  const result = await readDatasetCandlesAsync(req.params.id);
  if (!result.ok) {
    const status = result.error === 'dataset_not_found' ? 404 : 500;
    return res.status(status).json({ ok: false, error: result.error });
  }
  const { candles, meta, dataset } = result;
  const limit  = req.query.limit  ? Math.min(50000, parseInt(req.query.limit, 10))  : candles.length;
  const offset = req.query.offset ? Math.max(0, parseInt(req.query.offset, 10)) : 0;
  const slice  = candles.slice(offset, offset + limit);
  return res.json({ ok: true, candles: slice, count: slice.length, total: candles.length, meta, dataset });
});

// POST /api/historical/download
// Trigger historical data downloads.
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
    return res.status(400).json({ ok: false, error: `invalid_provider. Supported: ${VALID_PROVIDERS.join(', ')}` });
  }

  const VALID_PURPOSES = ['general', 'ml', 'backtest', 'correlation'];
  if (!VALID_PURPOSES.includes(purpose)) {
    return res.status(400).json({ ok: false, error: `invalid_purpose. Supported: ${VALID_PURPOSES.join(', ')}` });
  }

  try {
    const results = [];
    for (const symbol of symbols) {
      const result = await downloadHistoricalDataset({
        symbol,
        timeframe,
        provider,
        startDate,
        endDate,
        limit,
        purpose,
        credentials,
      });
      results.push({ symbol, ...result });
    }

    const failed = results.find((result) => !result.ok);
    if (failed) {
      return res.status(422).json({
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

    return res.json({
      ok:         true,
      symbols,
      dataset:    datasets[0] ?? null,
      datasets,
      candleCount,
      skipped,
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/historical/datasets/:id
// Delete a dataset and its backing file.
historicalRoutes.delete('/datasets/:id', async (req, res) => {
  try {
    const result = await deleteDataset(req.params.id);
    if (!result.ok) return res.status(404).json({ ok: false, error: result.error ?? 'dataset_not_found' });
    return res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/historical/status
// Health check for the historical data service.
historicalRoutes.get('/status', (_req, res) => {
  const datasets = listDatasets();
  return res.json({
    ok:           true,
    service:      'historical-data',
    datasetCount: datasets.length,
    providers:    listProviderCapabilities().map((p) => ({
      id:                  p.id,
      name:                p.name,
      requiresCredentials: p.requiresCredentials,
      timeframes:          p.timeframes,
    })),
  });
});

export default historicalRoutes;
