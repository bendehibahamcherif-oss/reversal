import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync, writeFileSync as wfs, statSync } from 'fs';
import { join } from 'path';
import os from 'node:os';

import historicalRoutes, { normalizeHistoricalDownloadSymbols } from '../api/historicalRoutes.js';
import { historicalDatasetRegistry } from '../historical/historicalDatasetRegistry.js';

let baseUrl;
let server;
let originalFetch;
let fetchCalls = [];
let initialRegistryJson;
let registryFile;
const createdDatasetFiles = new Set();

async function post(pathname, body) {
  const response = await originalFetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const parsedBody = contentType.includes('application/json') ? await response.json() : await response.text();
  for (const dataset of parsedBody?.datasets ?? []) {
    if (dataset?.filePath) createdDatasetFiles.add(dataset.filePath);
  }
  return { response, body: parsedBody, contentType };
}

async function get(pathname) {
  const response = await originalFetch(`${baseUrl}${pathname}`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body, contentType };
}

async function del(pathname) {
  const response = await originalFetch(`${baseUrl}${pathname}`, { method: 'DELETE' });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

function yahooChartResponse() {
  return {
    chart: {
      result: [
        {
          timestamp: [1749168000, 1749254400],
          indicators: {
            quote: [
              {
                open: [100, 101],
                high: [102, 103],
                low: [99, 100],
                close: [101, 102],
                volume: [1000, 1200],
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

test.before(async () => {
  const dirs = historicalDatasetRegistry.getDirectories();
  registryFile = join(dirs.DATA_DIR, 'datasets.json');
  initialRegistryJson = existsSync(registryFile) ? readFileSync(registryFile, 'utf-8') : null;

  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify(yahooChartResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const app = express();
  app.use(express.json());
  app.use('/api/historical', historicalRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.beforeEach(() => {
  fetchCalls = [];
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  for (const filePath of createdDatasetFiles) {
    rmSync(filePath, { force: true });
  }
  if (initialRegistryJson == null) {
    rmSync(registryFile, { force: true });
  } else {
    writeFileSync(registryFile, initialRegistryJson);
  }
  await new Promise((resolve) => server.close(resolve));
});

// ── normalizeHistoricalDownloadSymbols unit tests ─────────────────────────────

test('normalizeHistoricalDownloadSymbols trims, uppercases, splits comma strings, and removes empty values', () => {
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbols: [' nflx ', '', ' qqq '] }), ['NFLX', 'QQQ']);
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbols: 'SPY, QQQ' }), ['SPY', 'QQQ']);
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbol: ' nflx ' }), ['NFLX']);
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbols: [' ', null] }), []);
});

// ── Download endpoint ─────────────────────────────────────────────────────────

test('POST /api/historical/download accepts canonical symbols array without symbol_required', async () => {
  const { response, body, contentType } = await post('/api/historical/download', {
    provider: 'yahoo',
    symbols: ['NFLX'],
    timeframe: '1d',
    startDate: '2025-06-06',
    endDate: '2026-06-06',
    session: 'RTH',
    purpose: 'general',
    outputFormat: ['csv'],
    forceRefresh: false,
  });

  assert.equal(response.status, 200);
  assert.match(contentType, /application\/json/);
  assert.equal(body.ok, true);
  assert.deepEqual(body.symbols, ['NFLX']);
  assert.equal(body.dataset.symbol, 'NFLX');
  assert.notEqual(body.status, 'symbol_required');
});

test('POST /api/historical/download accepts legacy symbol string and normalizes it', async () => {
  const { response, body } = await post('/api/historical/download', {
    provider: 'yahoo',
    symbol: ' nflx ',
    timeframe: '1d',
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.symbols, ['NFLX']);
  assert.equal(body.dataset.symbol, 'NFLX');
  assert.match(fetchCalls[0], /NFLX/);
});

test('POST /api/historical/download safely normalizes symbols string payload', async () => {
  const { response, body } = await post('/api/historical/download', {
    provider: 'yahoo',
    symbols: 'nflx',
    timeframe: '1d',
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.symbols, ['NFLX']);
});

test('POST /api/historical/download returns structured symbol_required JSON for empty symbols', async () => {
  const { response, body, contentType } = await post('/api/historical/download', {
    provider: 'yahoo',
    symbols: [' ', ''],
    timeframe: '1d',
  });

  assert.equal(response.status, 400);
  assert.match(contentType, /application\/json/);
  assert.deepEqual(body, {
    ok: false,
    status: 'symbol_required',
    message: 'At least one symbol is required.',
    expected: {
      symbols: ['SPY', 'QQQ'],
    },
  });
  assert.equal(fetchCalls.length, 0);
});

test('POST /api/historical/download returns canonical datasetId/id and JSON-safe fields', async () => {
  const { response, body } = await post('/api/historical/download', {
    provider: 'yahoo', symbols: ['NFLX'], timeframe: '1d', startDate: '2025-06-06', endDate: '2026-06-06'
  });
  assert.equal(response.status, 200);
  assert.equal(body.dataset.datasetId, body.dataset.id);
  assert.equal(body.dataset.rowCount, 2);
  assert.deepEqual(body.dataset.symbols, ['NFLX']);
  assert.equal(JSON.stringify(body).includes('undefined'), false);
});

test('POST /api/historical/download rejects invalid provider', async () => {
  const { response, body } = await post('/api/historical/download', {
    symbols: ['SPY'], provider: 'bogus',
  });
  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
});

test('POST /api/historical/download rejects invalid purpose', async () => {
  const { response, body } = await post('/api/historical/download', {
    symbols: ['SPY'], provider: 'yahoo', purpose: 'bogus',
  });
  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
});

// ── Dataset list & detail ─────────────────────────────────────────────────────

test('GET /api/historical/datasets and detail return datasetId, and old id-only records normalize', async () => {
  const legacy = { id: 'legacy_id_only', symbol: 'SPY', timeframe: '1d', provider: 'yahoo', candleCount: 0, filePath: '' };
  historicalDatasetRegistry.saveDataset(legacy);
  const { response: listRes, body: listBody } = await get('/api/historical/datasets');
  assert.equal(listRes.status, 200);
  assert.ok(listBody.datasets.every((dataset) => dataset.datasetId && dataset.id));
  const legacyListed = listBody.datasets.find((dataset) => dataset.datasetId === 'legacy_id_only');
  assert.deepEqual(legacyListed.symbols, ['SPY']);
  assert.equal(legacyListed.rowCount, 0);

  const { response: detailRes, body: detailBody } = await get('/api/historical/datasets/legacy_id_only');
  assert.equal(detailRes.status, 200);
  assert.equal(detailBody.dataset.datasetId, 'legacy_id_only');
});

test('GET /api/historical/datasets includes fileExists and csvFileExists and status fields', async () => {
  const { body } = await get('/api/historical/datasets');
  assert.equal(body.ok, true);
  for (const d of body.datasets) {
    assert.equal(typeof d.fileExists, 'boolean', `fileExists should be boolean for dataset ${d.id}`);
    assert.equal(typeof d.csvFileExists, 'boolean', `csvFileExists should be boolean for dataset ${d.id}`);
    assert.ok(['ready', 'csv_missing', 'file_missing'].includes(d.status), `status should be a known value for dataset ${d.id}`);
  }
});

test('GET /api/historical/datasets/:datasetId returns structured dataset_not_found', async () => {
  const { response, body } = await get('/api/historical/datasets/missing_dataset');
  assert.equal(response.status, 404);
  assert.deepEqual(body, { ok: false, status: 'dataset_not_found', message: 'Historical dataset not found.', datasetId: 'missing_dataset' });
});

// ── Diagnostics endpoint ──────────────────────────────────────────────────────

test('GET /api/historical/datasets/:id/diagnostics returns 404 for unknown dataset', async () => {
  const { response, body } = await get('/api/historical/datasets/nonexistent-dataset-id/diagnostics');
  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.registryFound, false);
});

test('GET /api/historical/datasets/:id/diagnostics returns usableForMl=true for dataset with CSV', async () => {
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'hist-diag-test-'));
  const csvFilePath = join(tmpDir, 'SPY_1d_yahoo_diag.csv');
  writeFileSync(csvFilePath, [
    'timestamp,symbol,open,high,low,close,volume',
    '2026-01-01T00:00:00.000Z,SPY,500,502,499,501,1000000',
  ].join('\n'));
  const jsonFilePath = join(tmpDir, 'SPY_1d_yahoo_diag.json');
  writeFileSync(jsonFilePath, JSON.stringify({ meta: {}, candles: [] }));

  const record = historicalDatasetRegistry.register({
    symbol: 'SPY', timeframe: '1d', provider: 'yahoo',
    startDate: '2026-01-01', endDate: '2026-01-01', candleCount: 1,
    filePath: jsonFilePath,
    fileSize: statSync(jsonFilePath).size,
    files: { csv: csvFilePath, parquet: null, json: jsonFilePath },
    purpose: 'ml',
  });

  const { response, body } = await get(`/api/historical/datasets/${record.datasetId}/diagnostics`);
  assert.equal(response.status, 200);
  assert.equal(body.registryFound, true);
  assert.equal(typeof body.fileExists, 'boolean');
  assert.equal(typeof body.csvFileExists, 'boolean');
  assert.equal(typeof body.usableForMl, 'boolean');
  assert.ok(Array.isArray(body.issues));
  assert.equal(body.csvFileExists, true);
  assert.equal(body.usableForMl, true);

  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Providers & status ────────────────────────────────────────────────────────

test('GET /api/historical/providers returns ok=true with providers array', async () => {
  const { response, body } = await get('/api/historical/providers');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.providers));
  assert.ok(body.providers.length > 0, 'Should have at least one provider');
  const yahoo = body.providers.find((p) => p.id === 'yahoo');
  assert.ok(yahoo, 'yahoo provider should exist');
  assert.equal(yahoo.requiresCredentials, false);
});

test('GET /api/historical/status returns service status with counts', async () => {
  const { response, body } = await get('/api/historical/status');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, 'historical-data');
  assert.equal(typeof body.datasetCount, 'number');
  assert.equal(typeof body.readyCount, 'number');
  assert.ok(Array.isArray(body.providers));
});

// ── Delete ────────────────────────────────────────────────────────────────────

test('DELETE /api/historical/datasets/:id returns 404 for unknown dataset', async () => {
  const { response, body } = await del('/api/historical/datasets/nonexistent-id');
  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
});
