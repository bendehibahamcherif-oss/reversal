import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import historicalRoutes from '../api/historicalRoutes.js';
import { historicalDatasetRegistry } from '../historical/historicalDatasetRegistry.js';

let server;
let baseUrl;
let registryFile;
let initialRegistryJson;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dataset-usage-'));

function writeCsvDataset(datasetId, rows) {
  const csvPath = path.join(tmpDir, `${datasetId}.csv`);
  const header = 'timestamp,symbol,open,high,low,close,volume';
  const lines = rows.map((r) => `${r.timestamp},${r.symbol},${r.open},${r.high},${r.low},${r.close},${r.volume}`);
  fs.writeFileSync(csvPath, [header, ...lines].join('\n'));
  const jsonPath = path.join(tmpDir, `${datasetId}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: { datasetId }, candles: rows }));
  historicalDatasetRegistry.saveDataset({
    datasetId, id: datasetId, provider: 'yahoo', symbol: 'SPY', symbols: ['SPY'],
    timeframe: '1d', startDate: '2026-01-01', endDate: '2026-01-02', rowCount: rows.length,
    files: { csv: csvPath, parquet: null, json: jsonPath }, filePath: jsonPath, status: 'ready',
  });
  return { csvPath, jsonPath };
}

async function post(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const contentType = response.headers.get('content-type') || '';
  const parsed = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body: parsed, contentType };
}

test.before(async () => {
  const dirs = historicalDatasetRegistry.getDirectories();
  registryFile = join(dirs.DATA_DIR, 'datasets.json');
  initialRegistryJson = existsSync(registryFile) ? readFileSync(registryFile, 'utf-8') : null;
  const app = express();
  app.use(express.json());
  app.use('/api/historical', historicalRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (initialRegistryJson == null) rmSync(registryFile, { force: true });
  else writeFileSync(registryFile, initialRegistryJson);
  rmSync(tmpDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

for (const target of ['ml', 'backtest', 'correlation']) {
  test(`POST /api/historical/use-for-${target} without datasetId returns dataset_required (JSON 400)`, async () => {
    const { response, body, contentType } = await post(`/api/historical/use-for-${target}`, {});
    assert.equal(response.status, 400);
    assert.match(contentType, /application\/json/);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'dataset_required');
    // Must never claim success / never echo a literal "undefined" datasetId.
    assert.notEqual(body.datasetId, 'undefined');
    assert.equal(JSON.stringify(body).includes('"datasetId":"undefined"'), false);
  });

  test(`POST /api/historical/use-for-${target} with unknown datasetId returns dataset_not_found (404)`, async () => {
    const { response, body } = await post(`/api/historical/use-for-${target}`, { datasetId: 'no_such_dataset' });
    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'dataset_not_found');
    assert.equal(body.datasetId, 'no_such_dataset');
  });
}

test('POST /api/historical/use-for-ml with a CSV-backed dataset returns ready + real datasetId', async () => {
  writeCsvDataset('usage_ready_csv', [
    { timestamp: '2026-01-01T00:00:00Z', symbol: 'SPY', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
    { timestamp: '2026-01-02T00:00:00Z', symbol: 'SPY', open: 100, high: 102, low: 99, close: 101, volume: 1100 },
  ]);
  const { response, body } = await post('/api/historical/use-for-ml', { datasetId: 'usage_ready_csv' });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'ready');
  assert.equal(body.datasetId, 'usage_ready_csv');
  assert.equal(body.target, 'ml');
  assert.equal(body.usableForMl, true);
  assert.ok(body.dataset && body.dataset.datasetId === 'usage_ready_csv');
});

test('POST /api/historical/use-for-ml with JSON-only dataset returns dataset_csv_missing', async () => {
  const jsonPath = path.join(tmpDir, 'json_only.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: {}, candles: [{ timestamp: 1, symbol: 'SPY', close: 1 }] }));
  historicalDatasetRegistry.saveDataset({
    datasetId: 'usage_json_only', id: 'usage_json_only', provider: 'yahoo', symbol: 'SPY', symbols: ['SPY'],
    timeframe: '1d', rowCount: 1, files: { csv: null, parquet: null, json: jsonPath }, filePath: jsonPath, status: 'ready',
  });
  const { response, body } = await post('/api/historical/use-for-ml', { datasetId: 'usage_json_only' });
  assert.equal(response.status, 422);
  assert.equal(body.status, 'dataset_csv_missing');
  assert.equal(body.datasetId, 'usage_json_only');
});

test('POST /api/historical/use-for-backtest accepts a JSON-only dataset (ready)', async () => {
  // backtest/correlation can read JSON candles; only ML needs CSV.
  const { response, body } = await post('/api/historical/use-for-backtest', { datasetId: 'usage_json_only' });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'ready');
  assert.equal(body.target, 'backtest');
});

test('POST /api/historical/use-for-correlation with registered-but-file-missing returns dataset_file_missing', async () => {
  historicalDatasetRegistry.saveDataset({
    datasetId: 'usage_no_file', id: 'usage_no_file', provider: 'yahoo', symbol: 'SPY', symbols: ['SPY'],
    timeframe: '1d', rowCount: 0, files: { csv: null, parquet: null, json: path.join(tmpDir, 'gone.json') }, filePath: path.join(tmpDir, 'gone.json'), status: 'ready',
  });
  const { response, body } = await post('/api/historical/use-for-correlation', { datasetId: 'usage_no_file' });
  assert.equal(response.status, 404);
  assert.equal(body.status, 'dataset_file_missing');
});
