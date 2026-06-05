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
// Trigger a historical data download.
// Body: { symbol, timeframe, provider, startDate, endDate, limit, purpose, credentials }
historicalRoutes.post('/download', async (req, res) => {
  const {
    symbol,
    timeframe  = '1d',
    provider   = 'yahoo',
    startDate,
    endDate,
    limit,
    purpose    = 'general',
    credentials,
  } = req.body || {};

  if (!symbol) {
    return res.status(400).json({ ok: false, error: 'symbol_required' });
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
    const result = await downloadHistoricalDataset({
      symbol: String(symbol).toUpperCase(),
      timeframe,
      provider,
      startDate,
      endDate,
      limit,
      purpose,
      credentials,
    });

    if (!result.ok) {
      return res.status(422).json({ ok: false, error: result.error, detail: result.detail, warnings: result.warnings });
    }

    return res.json({
      ok:         true,
      dataset:    result.dataset,
      candleCount: result.candleCount,
      skipped:    result.skipped,
      warnings:   result.warnings,
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
