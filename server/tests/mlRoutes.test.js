import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

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

test('GET /api/ml/model-runs returns an empty runs array when no training jobs are active', async () => {
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
