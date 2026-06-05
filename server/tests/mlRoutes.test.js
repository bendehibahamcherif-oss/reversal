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
