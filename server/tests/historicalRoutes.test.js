import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import historicalRoutes, { normalizeHistoricalDownloadSymbols } from '../api/historicalRoutes.js';
import { historicalDatasetRegistry } from '../historical/historicalDatasetRegistry.js';

let baseUrl;
let server;
let originalFetch;
let fetchCalls = [];
let initialRegistryJson;
let registryFile;
const createdDatasetFiles = new Set();

async function request(pathname, body) {
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

test('normalizeHistoricalDownloadSymbols trims, uppercases, splits comma strings, and removes empty values', () => {
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbols: [' nflx ', '', ' qqq '] }), ['NFLX', 'QQQ']);
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbols: 'SPY, QQQ' }), ['SPY', 'QQQ']);
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbol: ' nflx ' }), ['NFLX']);
  assert.deepEqual(normalizeHistoricalDownloadSymbols({ symbols: [' ', null] }), []);
});

test('POST /api/historical/download accepts canonical symbols array without symbol_required', async () => {
  const { response, body, contentType } = await request('/api/historical/download', {
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
  const { response, body } = await request('/api/historical/download', {
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
  const { response, body } = await request('/api/historical/download', {
    provider: 'yahoo',
    symbols: 'nflx',
    timeframe: '1d',
  });

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.symbols, ['NFLX']);
});

test('POST /api/historical/download returns structured symbol_required JSON for empty symbols', async () => {
  const { response, body, contentType } = await request('/api/historical/download', {
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
  const { response, body } = await request('/api/historical/download', {
    provider: 'yahoo', symbols: ['NFLX'], timeframe: '1d', startDate: '2025-06-06', endDate: '2026-06-06'
  });
  assert.equal(response.status, 200);
  assert.equal(body.dataset.datasetId, body.dataset.id);
  assert.equal(body.dataset.rowCount, 2);
  assert.deepEqual(body.dataset.symbols, ['NFLX']);
  assert.equal(JSON.stringify(body).includes('undefined'), false);
});

test('GET /api/historical/datasets and detail return datasetId, and old id-only records normalize', async () => {
  const legacy = { id: 'legacy_id_only', symbol: 'SPY', timeframe: '1d', provider: 'yahoo', candleCount: 0, filePath: '' };
  historicalDatasetRegistry.saveDataset(legacy);
  const listResponse = await originalFetch(`${baseUrl}/api/historical/datasets`);
  const listBody = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.ok(listBody.datasets.every((dataset) => dataset.datasetId && dataset.id));
  const legacyListed = listBody.datasets.find((dataset) => dataset.datasetId === 'legacy_id_only');
  assert.deepEqual(legacyListed.symbols, ['SPY']);
  assert.equal(legacyListed.rowCount, 0);

  const detailResponse = await originalFetch(`${baseUrl}/api/historical/datasets/legacy_id_only`);
  const detailBody = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detailBody.dataset.datasetId, 'legacy_id_only');
});

test('GET /api/historical/datasets/:datasetId returns structured dataset_not_found', async () => {
  const response = await originalFetch(`${baseUrl}/api/historical/datasets/missing_dataset`);
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.deepEqual(body, { ok: false, status: 'dataset_not_found', message: 'Historical dataset not found.', datasetId: 'missing_dataset' });
});
