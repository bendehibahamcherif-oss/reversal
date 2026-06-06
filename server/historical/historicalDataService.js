/**
 * Historical Data Service — main orchestrator.
 * Dispatches download requests to the appropriate provider adapter,
 * serializes the result to JSON, and registers the dataset in the registry.
 */

import { writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';

import { yahooHistoricalProvider }        from './providers/yahooHistoricalProvider.js';
import { twelveDataHistoricalProvider }   from './providers/twelveDataHistoricalProvider.js';
import { polygonHistoricalProvider }      from './providers/polygonHistoricalProvider.js';
import { alphaVantageHistoricalProvider } from './providers/alphaVantageHistoricalProvider.js';
import { historicalDatasetRegistry }      from './historicalDatasetRegistry.js';
import { PROVIDER_CAPABILITIES }          from './providerCapabilities.js';

const PROVIDERS = {
  yahoo:        yahooHistoricalProvider,
  twelvedata:   twelveDataHistoricalProvider,
  polygon:      polygonHistoricalProvider,
  alphaVantage: alphaVantageHistoricalProvider,
};

function resolveTimestamp(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Download historical candles and store them as a dataset.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string} [opts.timeframe='1d']
 * @param {string} [opts.provider='yahoo']
 * @param {number|string} [opts.startDate]
 * @param {number|string} [opts.endDate]
 * @param {number} [opts.limit]
 * @param {string} [opts.purpose='general']
 * @param {object} [opts.credentials]
 * @returns {Promise<{ok, dataset?, error?, warnings?}>}
 */
export async function downloadHistoricalDataset({
  symbol,
  symbols,
  timeframe = '1d',
  provider = 'yahoo',
  startDate,
  endDate,
  limit,
  purpose = 'general',
  credentials,
  session = 'RTH',
}) {
  const adapter = PROVIDERS[provider];
  if (!adapter) return { ok: false, error: `unknown_provider:${provider}` };
  const normalizedSymbols = (Array.isArray(symbols) ? symbols : [symbol])
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
  if (!normalizedSymbols.length) return { ok: false, error: 'symbol_required' };
  symbol = normalizedSymbols[0];

  const now      = Date.now();
  const startMs  = resolveTimestamp(startDate, now - 365 * 86_400_000);
  const endMs    = resolveTimestamp(endDate, now);

  const result = await adapter.download({ symbol, timeframe, startMs, endMs, limit: limit ? Number(limit) : undefined, credentials });

  if (!result.ok) {
    return { ok: false, error: result.error, detail: result.detail, warnings: result.warnings ?? [] };
  }

  if (!result.candles?.length) {
    return {
      ok: false,
      error: 'no_candles_returned',
      warnings: result.warnings ?? [],
      detail: `Provider ${provider} returned 0 candles for ${symbol} ${timeframe}`,
    };
  }

  const dirs = historicalDatasetRegistry.getDirectories();
  const dir  = purpose === 'ml'          ? dirs.ML_DIR
             : purpose === 'backtest'    ? dirs.BACKTEST_DIR
             : purpose === 'correlation' ? dirs.CORRELATION_DIR
             : dirs.RAW_DIR;

  const sym      = String(symbol).toUpperCase();
  const compact = (value) => String(value || '').replace(/[^0-9A-Za-z]/g, '') || 'na';
  const datasetId = `hist_${sym}_${timeframe}_${String(session || 'RTH').toUpperCase()}_${compact(startDate || result.startDate)}_${compact(endDate || result.endDate)}_${provider}`;
  const filename = `${datasetId}.json`;
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);

  const payload = {
    meta: {
      datasetId,
      symbols:     [sym],
      symbol:      sym,
      timeframe,
      provider,
      startDate:   result.startDate,
      endDate:     result.endDate,
      rowCount:    result.candles.length,
      candleCount: result.candles.length,
      downloadedAt: new Date().toISOString(),
      purpose,
      session,
      sourceType:  result.candles[0]?.sourceType ?? 'market_data',
      warnings:    result.warnings ?? [],
    },
    candles: result.candles,
  };

  writeFileSync(filePath, JSON.stringify(payload));

  let fileSize = 0;
  try { fileSize = statSync(filePath).size; } catch { fileSize = JSON.stringify(payload).length; }

  const dataset = historicalDatasetRegistry.register({
    datasetId,
    symbol:      sym,
    symbols:     [sym],
    timeframe,
    provider,
    startDate:   result.startDate ?? '',
    endDate:     result.endDate   ?? '',
    candleCount: result.candles.length,
    rowCount:    result.candles.length,
    rowsBySymbol: { [sym]: result.candles.length },
    filePath,
    files:       { csv: null, parquet: null, json: filePath },
    fileSize,
    purpose,
    session,
    sourceType:  payload.meta.sourceType,
    warnings:    result.warnings ?? [],
  });

  return {
    ok: true,
    dataset,
    candleCount: result.candles.length,
    skipped:     result.skipped ?? 0,
    warnings:    result.warnings ?? [],
  };
}

/**
 * Read candles from a stored dataset file.
 */
export async function readDatasetCandlesAsync(datasetId) {
  const record = historicalDatasetRegistry.get(datasetId);
  if (!record) return { ok: false, error: 'dataset_not_found', datasetId };
  const filePath = record.files?.csv || record.files?.parquet || record.files?.json || record.filePath;
  if (!filePath || !existsSync(filePath)) return { ok: false, error: 'dataset_file_missing', datasetId, dataset: record };

  try {
    const raw    = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ok: true, candles: parsed.candles ?? [], meta: parsed.meta ?? {}, dataset: record };
  } catch (err) {
    return { ok: false, error: 'parse_error', detail: err?.message };
  }
}

/**
 * List all registered datasets (optionally filtered).
 */
export function listDatasets(filters = {}) {
  return historicalDatasetRegistry.list(filters);
}

/**
 * Get a single dataset record by id.
 */
export function getDataset(id) {
  return historicalDatasetRegistry.get(id);
}

/**
 * Delete a dataset record and its backing file.
 */
export async function deleteDataset(id) {
  const record = historicalDatasetRegistry.get(id);
  if (!record) return { ok: false, error: 'dataset_not_found' };

  if (existsSync(record.filePath)) {
    try { await unlink(record.filePath); } catch { /* already gone */ }
  }

  const deleted = historicalDatasetRegistry.delete(id);
  return { ok: deleted };
}

/**
 * List all provider capabilities.
 */
export function listProviderCapabilities() {
  return Object.values(PROVIDER_CAPABILITIES);
}
