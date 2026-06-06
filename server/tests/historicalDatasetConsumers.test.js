import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import mlRoutes from '../api/mlRoutes.js';
import backtestRoutes from '../api/backtestRoutes.js';
import macroRoutes from '../api/macroRoutes.js';
import multiAssetRoutes from '../api/multiAssetRoutes.js';
import { historicalDatasetRegistry } from '../historical/historicalDatasetRegistry.js';

let server;
let baseUrl;
let registryFile;
let initialRegistryJson;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-consumers-'));

function writeDataset(datasetId, rows) {
  const filePath = path.join(tmpDir, `${datasetId}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ meta: { datasetId }, candles: rows }));
  historicalDatasetRegistry.saveDataset({
    datasetId,
    id: datasetId,
    provider: 'yahoo',
    symbols: [...new Set(rows.map((row) => row.symbol))],
    symbol: rows[0]?.symbol || 'NFLX',
    timeframe: '1d',
    startDate: '2026-01-01',
    endDate: '2026-01-04',
    rowCount: rows.length,
    rowsBySymbol: rows.reduce((acc, row) => ({ ...acc, [row.symbol]: (acc[row.symbol] || 0) + 1 }), {}),
    files: { csv: null, parquet: null, json: filePath },
    filePath,
    status: 'ready',
  });
  return filePath;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

test.before(async () => {
  const dirs = historicalDatasetRegistry.getDirectories();
  registryFile = join(dirs.DATA_DIR, 'datasets.json');
  initialRegistryJson = existsSync(registryFile) ? readFileSync(registryFile, 'utf-8') : null;
  const app = express();
  app.use(express.json());
  app.use('/api/ml', mlRoutes);
  app.use('/api/backtest', backtestRoutes);
  app.use('/api/macro', macroRoutes);
  app.use('/api/multi-asset', multiAssetRoutes);
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

test('ML train with missing datasetId returns dataset_not_found', async () => {
  const { response, body } = await request('/api/ml/train', { method: 'POST', body: JSON.stringify({ symbol: 'SPY', timeframe: '1d', horizon: 10, datasetId: 'missing_ds' }) });
  // 404 matches the documented dataset error contract (see mlRoutes.test.js and
  // the sibling backtest assertion below); the route must NOT return generic 200.
  assert.equal(response.status, 404);
  assert.equal(body.status, 'dataset_not_found');
  assert.equal(body.datasetId, 'missing_ds');
});

test('ML train with datasetId and missing file returns dataset_file_missing', async () => {
  historicalDatasetRegistry.saveDataset({ datasetId: 'ml_missing_file', id: 'ml_missing_file', symbols: ['SPY'], provider: 'yahoo', files: { csv: null, parquet: null, json: path.join(tmpDir, 'missing.json') } });
  const { body } = await request('/api/ml/train', { method: 'POST', body: JSON.stringify({ symbol: 'SPY', timeframe: '1d', horizon: 10, datasetId: 'ml_missing_file' }) });
  assert.equal(body.status, 'dataset_file_missing');
  assert.equal(body.datasetId, 'ml_missing_file');
});

test('ML train with valid datasetId resolves registry file and includes datasetId', async () => {
  writeDataset('ml_valid_tiny', [
    { timestamp: 1, symbol: 'SPY', open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { timestamp: 2, symbol: 'SPY', open: 100, high: 102, low: 99, close: 101, volume: 1 },
  ]);
  const { body } = await request('/api/ml/train', { method: 'POST', body: JSON.stringify({ symbol: 'SPY', timeframe: '1d', horizon: 1, datasetId: 'ml_valid_tiny' }) });
  assert.equal(body.ok, false);
  assert.equal(body.datasetId, 'ml_valid_tiny');
  assert.notEqual(body.status, 'dataset_missing');
});

test('Backtest with missing and missing-file datasetId returns structured errors', async () => {
  let result = await request('/api/backtest/run', { method: 'POST', body: JSON.stringify({ symbol: 'NFLX', timeframe: '1d', datasetId: 'backtest_missing' }) });
  assert.equal(result.response.status, 404);
  assert.equal(result.body.status, 'dataset_not_found');
  historicalDatasetRegistry.saveDataset({ datasetId: 'backtest_missing_file', id: 'backtest_missing_file', symbols: ['NFLX'], files: { json: path.join(tmpDir, 'none.json') } });
  result = await request('/api/backtest/run', { method: 'POST', body: JSON.stringify({ symbol: 'NFLX', timeframe: '1d', datasetId: 'backtest_missing_file' }) });
  assert.equal(result.body.status, 'dataset_file_missing');
});

test('Backtest with datasetId includes historical_dataset dataSource.datasetId', async () => {
  writeDataset('backtest_valid', [
    { timestamp: 1, symbol: 'NFLX', open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { timestamp: 2, symbol: 'NFLX', open: 100, high: 102, low: 99, close: 101, volume: 1 },
    { timestamp: 3, symbol: 'NFLX', open: 101, high: 103, low: 100, close: 102, volume: 1 },
  ]);
  const { body } = await request('/api/backtest/run', { method: 'POST', body: JSON.stringify({ symbol: 'NFLX', timeframe: '1d', datasetId: 'backtest_valid' }) });
  assert.equal(body.ok, true);
  assert.equal(body.dataSource.type, 'historical_dataset');
  assert.equal(body.dataSource.datasetId, 'backtest_valid');
});

test('Correlation and beta with datasetId never return NaN and report not_enough_data for no overlap', async () => {
  writeDataset('macro_sparse', [
    { timestamp: 1, symbol: 'NFLX', close: 100 },
    { timestamp: 2, symbol: 'NFLX', close: 101 },
    { timestamp: 5, symbol: 'SPY', close: 200 },
    { timestamp: 6, symbol: 'SPY', close: 201 },
  ]);
  const corr = await request('/api/macro/correlation?datasetId=macro_sparse&symbols=NFLX,SPY&window=20');
  assert.equal(corr.body.status, 'not_enough_data');
  assert.equal(corr.body.observations, 0);
  assert.equal(JSON.stringify(corr.body).includes('NaN'), false);
  const beta = await request('/api/macro/beta?datasetId=macro_sparse&asset=NFLX&benchmark=SPY&window=20');
  assert.equal(beta.body.status, 'not_enough_data');
  assert.equal(beta.body.beta, null);
  assert.equal(beta.body.r2, null);
  assert.equal(JSON.stringify(beta.body).includes('NaN'), false);
});

test('Correlation with overlapping datasetId resolves registry file', async () => {
  writeDataset('macro_overlap', [
    { timestamp: 1, symbol: 'NFLX', close: 100 },
    { timestamp: 2, symbol: 'NFLX', close: 110 },
    { timestamp: 3, symbol: 'NFLX', close: 121 },
    { timestamp: 4, symbol: 'NFLX', close: 133.1 },
    { timestamp: 1, symbol: 'SPY', close: 200 },
    { timestamp: 2, symbol: 'SPY', close: 220 },
    { timestamp: 3, symbol: 'SPY', close: 242 },
    { timestamp: 4, symbol: 'SPY', close: 266.2 },
  ]);
  const { body } = await request('/api/macro/correlation?datasetId=macro_overlap&symbols=NFLX,SPY&window=20');
  assert.equal(body.status, 'ok');
  assert.equal(body.datasetId, 'macro_overlap');
  assert.deepEqual(body.matrix, [[1, 1], [1, 1]]);
});
