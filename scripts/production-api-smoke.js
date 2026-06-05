#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const API_BASE = (process.env.API_BASE || 'https://reversal.onrender.com').replace(/\/$/, '');
const OUTPUT = 'PRODUCTION_API_SMOKE_RESULTS.json';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 10000);

const endpoints = [
  { method: 'GET', endpoint: '/api/ml/health', keys: ['ok', 'status', 'worker'] },
  { method: 'GET', endpoint: '/api/ml/model', keys: ['ok', 'champion', 'challengers', 'status'] },
  { method: 'GET', endpoint: '/api/ml/model-runs?symbol=SPY', keys: ['ok', 'runs', 'symbol', 'status'] },
  { method: 'GET', endpoint: '/api/ml/training-runs?symbol=SPY', keys: ['ok', 'runs', 'symbol', 'status'] },
  { method: 'GET', endpoint: '/api/ml/predictions?symbol=SPY', keys: ['ok', 'predictions', 'symbol', 'status'] },
  { method: 'GET', endpoint: '/api/ml/feature-importance', keys: ['ok', 'features', 'status'] },
  { method: 'GET', endpoint: '/api/ml/drift', keys: ['ok', 'drift'] },
  { method: 'GET', endpoint: '/api/ml/model-card', keys: ['ok', 'modelCard', 'status'] },
  { method: 'POST', endpoint: '/api/ml/train', body: { symbol: 'SPY', dryRun: true }, keys: ['ok', 'status', 'message', 'details'] },
  { method: 'POST', endpoint: '/api/ml/infer/SPY', body: { features: { close: 500, volume: 1000 }, timeframe: '1m' }, keys: ['ok', 'status', 'message'] },
  { method: 'GET', endpoint: '/api/multi-asset/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', keys: ['ok', 'symbols', 'matrix'] },
  { method: 'GET', endpoint: '/api/multi-asset/sector-rotation?window=20&timeframe=1d&benchmark=SPY', keys: ['ok', 'sectors'] },
  { method: 'GET', endpoint: '/api/multi-asset/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', keys: ['ok', 'symbols', 'heatmap'] },
  { method: 'GET', endpoint: '/api/macro/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', keys: ['ok', 'symbols', 'matrix', 'status'] },
  { method: 'GET', endpoint: '/api/macro/beta?asset=QQQ&benchmark=SPY&window=20', keys: ['ok', 'asset', 'benchmark', 'beta', 'r2', 'status'] },
  { method: 'GET', endpoint: '/api/macro/sector-rotation?window=20&timeframe=1d&benchmark=SPY', keys: ['ok', 'sectors', 'status'] },
  { method: 'GET', endpoint: '/api/macro/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', keys: ['ok', 'symbols', 'heatmap', 'status'] },
];

function hasOwn(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

async function check(spec) {
  const url = `${API_BASE}${spec.endpoint}`;
  const result = {
    endpoint: spec.endpoint,
    method: spec.method,
    status: null,
    contentType: null,
    validJson: false,
    shapeOk: false,
    error: null,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: spec.method,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: spec.body ? JSON.stringify(spec.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    result.status = response.status;
    result.contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (response.status === 404) result.error = 'HTTP 404';
    if (/text\/html/i.test(result.contentType)) result.error = 'HTML response';

    let json;
    try {
      json = text ? JSON.parse(text) : null;
      result.validJson = true;
    } catch (err) {
      result.error = `Invalid JSON: ${err.message}`;
      result.bodyPreview = text.slice(0, 120);
      return result;
    }

    const missing = spec.keys.filter((key) => !hasOwn(json, key));
    result.shapeOk = missing.length === 0;
    if (missing.length) result.error = `Missing keys: ${missing.join(', ')}`;
    if (response.status >= 500) result.error = `HTTP ${response.status}`;
    return result;
  } catch (err) {
    result.error = err.message;
    return result;
  }
}

const results = [];
for (const endpoint of endpoints) {
  results.push(await check(endpoint));
}

await writeFile(OUTPUT, `${JSON.stringify({ apiBase: API_BASE, generatedAt: new Date().toISOString(), results }, null, 2)}\n`);

const failed = results.filter((r) => r.status === 404 || /text\/html/i.test(r.contentType || '') || !r.validJson || !r.shapeOk || r.error);
for (const r of results) {
  const marker = failed.includes(r) ? 'FAIL' : 'PASS';
  console.log(`${marker} ${r.method} ${r.endpoint} status=${r.status} contentType=${r.contentType} validJson=${r.validJson} shapeOk=${r.shapeOk}${r.error ? ` error=${r.error}` : ''}`);
}

if (failed.length) process.exit(1);
