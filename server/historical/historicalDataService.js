/**
 * Historical Data Service — main orchestrator.
 * Dispatches download requests to the appropriate provider adapter,
 * serializes candles to JSON + CSV, and registers the dataset in the registry.
 *
 * CSV is the canonical ML-training format expected by train_pipeline.py.
 * JSON is kept as a full-fidelity archive (includes provider/session/sourceType).
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

// Columns required by train_pipeline.py
const CSV_COLUMNS = ['timestamp', 'symbol', 'open', 'high', 'low', 'close', 'volume'];

function resolveTimestamp(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Convert canonical candle array to CSV string.
 * timestamp is written as ISO 8601 — pd.to_datetime() in Python handles it.
 */
function candlesToCsv(candles) {
  const header = CSV_COLUMNS.join(',');
  const rows = candles.map((c) => {
    const ts = new Date(c.timestamp).toISOString();
    return [ts, c.symbol, c.open, c.high, c.low, c.close, c.volume].join(',');
  });
  return [header, ...rows].join('\n');
}

/**
 * Download historical candles and store them as CSV + JSON dataset.
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
  const csvPath  = join(dir, `${datasetId}.csv`);

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

  // Write full JSON archive
  writeFileSync(filePath, JSON.stringify(payload));

  // Write CSV for Python train_pipeline.py (required columns only)
  writeFileSync(csvPath, candlesToCsv(result.candles));

  let fileSize = 0;
  let csvSize  = 0;
  try { fileSize = statSync(filePath).size; } catch { fileSize = JSON.stringify(payload).length; }
  try { csvSize  = statSync(csvPath).size;  } catch { csvSize  = 0; }

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
    files:       { csv: csvPath, parquet: null, json: filePath },
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


function parseCsvCandles(raw) {
  const lines = String(raw || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    headers.forEach((header, index) => { row[header] = cols[index]; });
    for (const key of ['open', 'high', 'low', 'close', 'volume']) {
      if (row[key] !== undefined) {
        const n = Number(row[key]);
        row[key] = Number.isFinite(n) ? n : null;
      }
    }
    return row;
  }).filter((row) => row.timestamp && row.symbol);
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
    const raw = await readFile(filePath, 'utf-8');
    if (String(filePath).toLowerCase().endsWith('.csv')) {
      const candles = parseCsvCandles(raw);
      return { ok: true, candles, meta: { datasetId, sourceFormat: 'csv' }, dataset: record };
    }
    const parsed = JSON.parse(raw);
    return { ok: true, candles: parsed.candles ?? [], meta: parsed.meta ?? {}, dataset: record };
  } catch (err) {
    return { ok: false, error: 'parse_error', detail: err?.message };
  }
}

/**
 * Get the best file path for ML training (CSV preferred, JSON fallback).
 * Returns { ok, path, format } or { ok: false, error }.
 */
export function resolveDatasetForTraining(datasetId) {
  const record = historicalDatasetRegistry.get(datasetId);
  if (!record) {
    return { ok: false, error: 'dataset_not_found', datasetId };
  }

  const csvPath = record.files?.csv || null;
  const candidates = [
    { path: csvPath,         format: 'csv' },
    { path: record.filePath, format: 'json' },
  ].filter((c) => c.path);

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    let size = 0;
    try { size = statSync(candidate.path).size; } catch { continue; }
    if (size === 0) continue;
    if (candidate.format === 'json') {
      // JSON is not readable by train_pipeline.py — skip
      continue;
    }
    return { ok: true, path: candidate.path, format: candidate.format, dataset: record };
  }

  // CSV missing — check if JSON exists (file_missing vs csv_not_generated)
  const jsonExists = record.filePath && existsSync(record.filePath);
  const csvExists  = csvPath && existsSync(csvPath);

  if (!csvExists && jsonExists) {
    return { ok: false, error: 'dataset_csv_missing', datasetId, detail: 'Dataset JSON exists but CSV was not generated. Re-download the dataset.', filePath: record.filePath, csvPath: csvPath ?? null };
  }

  const candidatePaths = candidates.map((c) => c.path);
  return { ok: false, error: 'dataset_file_missing', datasetId, candidatePaths, dataset: record };
}

/**
 * Diagnose a dataset for ML readiness.
 */
export function diagnoseDataset(datasetId) {
  const record = historicalDatasetRegistry.get(datasetId);
  if (!record) {
    return { ok: true, datasetId, registryFound: false, fileExists: false, csvFileExists: false, usableForMl: false, issues: ['dataset_not_found'] };
  }

  const csvPath    = record.files?.csv || null;
  const jsonExists = record.filePath ? existsSync(record.filePath) : false;
  const csvExists  = csvPath ? existsSync(csvPath) : false;

  let jsonSize = 0;
  let csvSize  = 0;
  try { if (jsonExists) jsonSize = statSync(record.filePath).size;  } catch { /* */ }
  try { if (csvExists)  csvSize  = statSync(csvPath).size;          } catch { /* */ }

  const issues = [];
  if (!jsonExists) issues.push('dataset_file_missing');
  if (!csvExists)  issues.push('dataset_csv_missing');
  if (csvExists && csvSize === 0) issues.push('dataset_file_empty');

  const usableForMl = csvExists && csvSize > 0;

  return {
    ok: true,
    datasetId,
    registryFound:   true,
    dataset:         record,
    fileExists:      jsonExists,
    fileSizeBytes:   jsonSize,
    csvFileExists:   csvExists,
    csvSizeBytes:    csvSize,
    usableForMl,
    issues,
    candidatePaths: [csvPath, record.filePath].filter(Boolean),
  };
}

/**
 * List all registered datasets with live file-existence status.
 */
export function listDatasets(filters = {}) {
  const records = historicalDatasetRegistry.list(filters);
  return records.map((d) => {
    const csvPath    = d.files?.csv || null;
    const jsonExists = d.filePath ? existsSync(d.filePath) : false;
    const csvExists  = csvPath ? existsSync(csvPath) : false;
    return {
      ...d,
      fileExists:    jsonExists,
      csvFileExists: csvExists,
      status:        csvExists ? 'ready' : (jsonExists ? 'csv_missing' : 'file_missing'),
    };
  });
}

/**
 * Get a single dataset record by id.
 */
export function getDataset(id) {
  return historicalDatasetRegistry.get(id);
}

/**
 * Delete a dataset record and its backing files.
 */
export async function deleteDataset(id) {
  const record = historicalDatasetRegistry.get(id);
  if (!record) return { ok: false, error: 'dataset_not_found' };

  const csvPath = record.files?.csv || null;
  for (const p of [record.filePath, csvPath].filter(Boolean)) {
    if (existsSync(p)) {
      try { await unlink(p); } catch { /* already gone */ }
    }
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
