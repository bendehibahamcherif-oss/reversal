#!/usr/bin/env node
/* eslint-disable no-console */

const BASE_URL = process.env.ML_DEBUG_BASE_URL || process.env.API_BASE_URL || 'http://127.0.0.1:3000';

async function request(pathname, options = {}) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

function datasetRows(dataset) {
  return Number(dataset?.rowCount ?? dataset?.candleCount ?? 0);
}

function datasetCreatedAt(dataset) {
  return Date.parse(dataset?.createdAt || dataset?.downloadedAt || dataset?.endDate || 0) || 0;
}

async function main() {
  console.log(`Using API base URL: ${BASE_URL}`);
  const { response: listResponse, body: listBody } = await request('/api/historical/datasets');
  if (!listResponse.ok || !listBody?.ok) {
    console.error('Failed to list historical datasets:');
    console.error(JSON.stringify(listBody, null, 2));
    process.exit(1);
  }

  const datasets = Array.isArray(listBody.datasets) ? listBody.datasets : [];
  const ready = datasets
    .filter((dataset) => dataset.status === 'ready' || dataset.csvFileExists || dataset.files?.csv)
    .sort((a, b) => datasetCreatedAt(b) - datasetCreatedAt(a));

  console.log(`Historical datasets: ${datasets.length}; ready for ML: ${ready.length}`);
  if (!ready.length) {
    console.error('No ready historical dataset found. Download a historical ML dataset first.');
    process.exit(1);
  }

  const dataset = ready[0];
  const symbol = String(dataset.symbol || dataset.symbols?.[0] || 'SPY').toUpperCase();
  const timeframe = String(dataset.timeframe || '1d');
  const horizon = Number(process.env.ML_DEBUG_HORIZON || 10);
  console.log(`Selected dataset: ${dataset.datasetId || dataset.id} · ${datasetRows(dataset)} rows`);

  const payload = {
    datasetId: dataset.datasetId || dataset.id,
    symbol,
    timeframe,
    horizon,
    promote: process.env.ML_DEBUG_PROMOTE === 'true',
  };
  console.log('POST /api/ml/train payload:');
  console.log(JSON.stringify(payload, null, 2));

  const { response: trainResponse, body: trainBody } = await request('/api/ml/train', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  console.log(`HTTP ${trainResponse.status}`);
  console.log(JSON.stringify(trainBody, null, 2));

  if (trainBody?.status === 'training_failed') {
    const details = trainBody.details?.process || trainBody.details || {};
    if (details.stderrPreview) {
      console.error('\n--- stderrPreview ---');
      console.error(details.stderrPreview);
    }
    if (details.stdoutPreview) {
      console.error('\n--- stdoutPreview ---');
      console.error(details.stdoutPreview);
    }
  }

  process.exit(trainBody?.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
