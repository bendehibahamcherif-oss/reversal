#!/usr/bin/env node
import fs from 'node:fs';
import express from 'express';

async function withLocalServer() {
  const [{ default: mlRoutes }, { default: historicalRoutes }] = await Promise.all([
    import('../server/api/mlRoutes.js'),
    import('../server/api/historicalRoutes.js'),
  ]);
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ml', mlRoutes);
  app.use('/api/historical', historicalRoutes);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function requestJson(baseUrl, method, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  return { httpStatus: response.status, body: payload };
}

function datasetTime(dataset) {
  return Date.parse(dataset.createdAt || dataset.endDate || dataset.startDate || 0) || 0;
}

let server = null;
const baseUrlFromEnv = process.env.ML_SMOKE_BASE_URL || process.env.BASE_URL || '';
const base = baseUrlFromEnv ? { baseUrl: baseUrlFromEnv.replace(/\/$/, ''), close: async () => {} } : await withLocalServer();
server = base;
const results = { baseUrl: base.baseUrl, startedAt: new Date().toISOString(), steps: [] };

try {
  const dependencies = await requestJson(base.baseUrl, 'GET', '/api/ml/dependencies');
  results.steps.push({ step: 'dependencies', ...dependencies });
  if (dependencies.body?.status !== 'ready') {
    throw new Error(`Expected /api/ml/dependencies status ready, received ${dependencies.body?.status}`);
  }

  const datasets = await requestJson(base.baseUrl, 'GET', '/api/historical/datasets');
  results.steps.push({ step: 'datasets', httpStatus: datasets.httpStatus, count: datasets.body?.count ?? datasets.body?.datasets?.length ?? null });
  const latestReady = [...(datasets.body?.datasets || [])]
    .filter((dataset) => dataset.status === 'ready')
    .sort((a, b) => datasetTime(b) - datasetTime(a))[0];
  if (!latestReady) throw new Error('No ready historical dataset is registered.');

  const datasetId = latestReady.datasetId || latestReady.id;
  const trainBody = { symbol: 'SPY', timeframe: '1d', horizon: 10, datasetId, promote: false };
  const train = await requestJson(base.baseUrl, 'POST', '/api/ml/train', trainBody);
  results.steps.push({ step: 'train', request: trainBody, ...train });

  if (train.body?.status === 'python_dependency_missing' && dependencies.body?.status === 'ready') {
    throw new Error('BUG: train route dependency check disagrees with /api/ml/dependencies');
  }

  results.ok = true;
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync('ML_TRAIN_SMOKE_RESULTS.json', `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  results.ok = false;
  results.error = err.message;
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync('ML_TRAIN_SMOKE_RESULTS.json', `${JSON.stringify(results, null, 2)}\n`);
  console.error(err.message);
  process.exitCode = 1;
} finally {
  if (server) await server.close();
}
