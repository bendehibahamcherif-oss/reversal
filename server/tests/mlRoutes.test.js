import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.ML_ARTIFACTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-artifacts-'));

let baseUrl;
let server;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

test.before(async () => {
  const mlRoutes = (await import('../api/mlRoutes.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/ml', mlRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/ml/drift returns structured empty drift state', async () => {
  const { response, body } = await request('/api/ml/drift');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.drift, {
    status: 'not_enough_data',
    psi: {},
    features: [],
    lastComputedAt: null,
    message: 'Drift monitoring requires at least two inference windows. Run inference on more data.',
  });
});

test('GET /api/ml/model-runs returns an empty runs array when no models are registered', async () => {
  const { response, body } = await request('/api/ml/model-runs');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.runs, []);
});

test('GET /api/ml/model returns no_model instead of endpoint unavailable when no champion exists', async () => {
  const { response, body } = await request('/api/ml/model');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.champion, null);
  assert.deepEqual(body.challengers, []);
  assert.equal(body.status, 'no_model');
});

test('POST /api/ml/infer/:symbol returns no_champion_model empty state when no champion exists', async () => {
  const { response, body } = await request('/api/ml/infer/SPY', {
    method: 'POST',
    body: JSON.stringify({ features: { close: 500, volume: 1000 }, timeframe: '1m' }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'no_champion_model');
  assert.equal(body.message, 'No champion model available. Train and promote a model first.');
});


test('GET /api/ml/health returns route-available worker contract', async () => {
  const { response, body } = await request('/api/ml/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'available');
  assert.equal(typeof body.worker.available, 'boolean');
  assert.equal(typeof body.worker.mode, 'string');
});

test('GET /api/ml/predictions returns empty predictions state', async () => {
  const { response, body } = await request('/api/ml/predictions');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.predictions, []);
});

test('GET /api/ml/feature-importance returns empty features state when no champion exists', async () => {
  const { response, body } = await request('/api/ml/feature-importance');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.features, []);
});

test('GET /api/ml/model-card returns not_available empty state as JSON', async () => {
  const { response, body } = await request('/api/ml/model-card', { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.modelCard, null);
  assert.equal(body.status, 'not_available');
});

test('GET /api/ml/model-runs accepts optional symbol and returns empty status', async () => {
  const { response, body } = await request('/api/ml/model-runs?symbol=spy');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.symbol, 'SPY');
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.runs, []);
});

test('GET /api/ml/predictions accepts optional symbol and returns empty status', async () => {
  const { response, body } = await request('/api/ml/predictions?symbol=spy');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.symbol, 'SPY');
  assert.equal(body.status, 'empty');
  assert.deepEqual(body.predictions, []);
});

test('POST /api/ml/train with no dataset returns dataset_missing JSON', async () => {
  const { response, body } = await request('/api/ml/train', {
    method: 'POST',
    body: JSON.stringify({ symbol: 'SPY', timeframe: '1m', horizon: 20 }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'dataset_missing');
  assert.equal(body.message, 'No dataset snapshot found. Generate or upload a dataset before training.');
  assert.ok(Array.isArray(body.expectedPaths));
});

test('POST /api/ml/train with unknown datasetId returns dataset_not_found (not dataset_missing)', async () => {
  const { response, body } = await request('/api/ml/train', {
    method: 'POST',
    body: JSON.stringify({ symbol: 'SPY', timeframe: '1m', horizon: 20, datasetId: 'nonexistent-dataset-id' }),
  });
  assert.equal(response.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'dataset_not_found');
  assert.equal(body.datasetId, 'nonexistent-dataset-id');
  assert.notEqual(body.status, 'dataset_missing', 'Must NOT return dataset_missing when datasetId was provided');
});

test('POST /api/ml/train with registered dataset but csv missing returns dataset_csv_missing', async () => {
  const { historicalDatasetRegistry } = await import('../historical/historicalDatasetRegistry.js');
  const { DATA_DIR } = historicalDatasetRegistry.getDirectories();
  const registryFile = path.join(DATA_DIR, 'datasets.json');
  const registrySnapshot = fs.existsSync(registryFile) ? fs.readFileSync(registryFile, 'utf-8') : null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-csv-miss-'));
  const jsonPath = path.join(tmpDir, 'SPY_1d_yahoo_test.json');
  fs.writeFileSync(jsonPath, JSON.stringify([{ timestamp: '2026-01-01T00:00:00Z', symbol: 'SPY', open: 500, high: 502, low: 499, close: 501, volume: 1000000 }]));

  const record = historicalDatasetRegistry.register({
    symbol: 'SPY', timeframe: '1d', provider: 'yahoo',
    startDate: '2026-01-01', endDate: '2026-01-01', candleCount: 1,
    filePath: jsonPath,
    fileSize: fs.statSync(jsonPath).size,
    csvPath: null,
    purpose: 'ml',
  });

  try {
    const { response, body } = await request('/api/ml/train', {
      method: 'POST',
      body: JSON.stringify({ symbol: 'SPY', timeframe: '1d', horizon: 20, datasetId: record.id }),
    });
    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'dataset_csv_missing');
    assert.equal(body.datasetId, record.id);
  } finally {
    if (registrySnapshot === null) fs.rmSync(registryFile, { force: true });
    else fs.writeFileSync(registryFile, registrySnapshot);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});



test('POST /api/ml/train with small synthetic CSV returns JSON not_enough_data', async () => {
  const datasetPath = path.join(process.env.ML_ARTIFACTS_DIR, 'tiny_features_snapshot.csv');
  fs.writeFileSync(datasetPath, [
    'timestamp,symbol,open,high,low,close,volume',
    '2026-01-01T14:30:00Z,SPY,100,101,99,100.5,1000',
    '2026-01-01T14:31:00Z,SPY,100.5,101.5,100,101,1200',
    '2026-01-01T14:32:00Z,SPY,101,102,100.5,101.5,1100',
  ].join('\n'));
  const { response, body } = await request('/api/ml/train', {
    method: 'POST',
    body: JSON.stringify({ symbol: 'SPY', timeframe: '1m', horizon: 2, datasetPath }),
  });
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'not_enough_data');
});

test('POST /api/ml/infer/:symbol returns no champion before validating empty payload', async () => {
  const { response, body } = await request('/api/ml/infer/SPY', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'no_champion_model');
});

test('POST /api/ml/promote/:modelId sets champion and GET /api/ml/model returns it', async () => {
  const { modelRegistry } = await import('../ai/modelRegistry.js');
  const model = modelRegistry.register({
    modelId: 'test-promote-model',
    symbol: 'SPY',
    timeframe: '1m',
    horizon: 20,
    datasetHash: 'sha256:test',
    featureSchemaHash: 'sha256:schema',
    metrics: { accuracy: 0.5 },
    artifactPath: process.env.ML_ARTIFACTS_DIR,
    status: 'candidate',
  });
  assert.equal(model.status, 'candidate');

  const promoted = await request('/api/ml/promote/test-promote-model', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(promoted.response.status, 200);
  assert.equal(promoted.body.ok, true);
  assert.equal(promoted.body.model.status, 'champion');

  const { response, body } = await request('/api/ml/model');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.champion.modelId, 'test-promote-model');
});

test('GET /api/ml/dependencies returns JSON with dependencies map', async () => {
  const { response, body } = await request('/api/ml/dependencies');
  assert.equal(response.status, 200);
  assert.equal(typeof body.ok, 'boolean');
  assert.ok(body.python, 'Should have python field');
  assert.equal(typeof body.python.available, 'boolean');
  assert.ok(body.dependencies, 'Should have dependencies map');
  assert.equal(typeof body.dependencies.pandas, 'boolean');
  assert.equal(typeof body.dependencies.numpy, 'boolean');
  assert.equal(typeof body.dependencies.sklearn, 'boolean');
  assert.ok(['ready', 'python_dependency_missing', 'python_unavailable'].includes(body.status), `Unexpected status: ${body.status}`);
});

test('GET /api/ml/dependencies returns pythonBin field', async () => {
  const { response, body } = await request('/api/ml/dependencies');
  assert.equal(response.status, 200);
  assert.equal(typeof body.pythonBin, 'string');
  assert.ok(body.pythonBin.length > 0);
});

test('POST /api/ml/train with ML_PYTHON_BIN env override uses that binary', async () => {
  const orig = process.env.ML_PYTHON_BIN;
  process.env.ML_PYTHON_BIN = 'python3';
  const { response, body } = await request('/api/ml/train', {
    method: 'POST',
    body: JSON.stringify({ symbol: 'SPY', timeframe: '1m', horizon: 20 }),
  });
  process.env.ML_PYTHON_BIN = orig;
  assert.equal(response.status, 200);
  assert.equal(body.ok, false);
  // Should get dataset_missing or not_enough_data — not a spawn error
  assert.notEqual(body.status, 'python_unavailable');
});
