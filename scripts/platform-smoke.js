#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_PORT = Number(process.env.PLATFORM_SMOKE_PORT || 18080);
const baseUrl = process.env.PLATFORM_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const startedBySmoke = !process.env.PLATFORM_BASE_URL;

const endpoints = [
  { method: 'GET', path: '/api/ml/health', keys: ['ok', 'status', 'worker'] },
  { method: 'GET', path: '/api/ml/model', keys: ['ok', 'champion', 'challengers', 'status'] },
  { method: 'GET', path: '/api/ml/model-runs', keys: ['ok', 'runs'] },
  { method: 'GET', path: '/api/ml/predictions', keys: ['ok', 'predictions'] },
  { method: 'GET', path: '/api/ml/feature-importance', keys: ['ok', 'features'] },
  { method: 'GET', path: '/api/ml/drift', keys: ['ok', 'drift'] },
  { method: 'GET', path: '/api/ml/model-card', keys: ['ok', 'modelCard', 'status'], headers: { accept: 'application/json' } },
  { method: 'GET', path: '/api/providers/health', keys: ['success', 'providers', 'activeProviders'] },
  { method: 'GET', path: '/api/providers/credentials', keys: ['success', 'credentials'] },
  { method: 'GET', path: '/api/providers/active', keys: ['success', 'activeProviders'] },
  { method: 'GET', path: '/api/feed/status', keys: ['ok', 'success', 'providers'] },
  { method: 'GET', path: '/api/feeds/tick/SPY', keys: ['success'] },
  { method: 'GET', path: '/api/feeds/candle/SPY', keys: ['success'] },
  { method: 'GET', path: '/api/feeds/orderbook/SPY', keys: ['success'] },
  { method: 'GET', path: '/api/portfolio/summary', keys: ['ok', 'positions', 'exposure'] },
  { method: 'GET', path: '/api/portfolio/positions', keys: ['ok', 'positions'] },
  { method: 'GET', path: '/api/portfolio/pnl', keys: ['ok', 'pnl'] },
  { method: 'GET', path: '/api/portfolio/exposure', keys: ['ok', 'exposure'] },
  { method: 'GET', path: '/api/portfolio/drawdown', keys: ['ok', 'drawdown'] },
  { method: 'GET', path: '/api/risk/summary', keys: ['ok', 'risk'] },
  { method: 'GET', path: '/api/risk/exposure', keys: ['ok', 'exposure'] },
  { method: 'GET', path: '/api/risk/drawdown', keys: ['ok', 'drawdown'] },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return true;
    } catch {
      // retry
    }
    await wait(200);
  }
  return false;
}

async function runEndpoint(endpoint) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method,
      headers: { 'content-type': 'application/json', ...(endpoint.headers || {}) },
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      return {
        ...endpoint,
        status: response.status,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: `invalid_json: ${error.message}`,
      };
    }
    const missingKeys = endpoint.keys.filter((key) => !Object.hasOwn(body || {}, key));
    return {
      ...endpoint,
      status: response.status,
      ok: response.status !== 404 && missingKeys.length === 0,
      durationMs: Date.now() - startedAt,
      missingKeys,
      topLevelKeys: body && typeof body === 'object' ? Object.keys(body) : [],
      bodyStatus: body?.status || body?.risk?.status || null,
    };
  } catch (error) {
    return {
      ...endpoint,
      status: null,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error.message,
    };
  }
}

let child = null;
try {
  if (startedBySmoke) {
    child = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: String(DEFAULT_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    const ready = await waitForServer(baseUrl);
    if (!ready) throw new Error(`Server did not become healthy at ${baseUrl}`);
  }

  const results = [];
  for (const endpoint of endpoints) results.push(await runEndpoint(endpoint));
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  const payload = {
    ok: failed === 0,
    baseUrl,
    generatedAt: new Date().toISOString(),
    summary: { total: results.length, passed, failed },
    results,
  };
  await writeFile('PLATFORM_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (failed) process.exitCode = 1;
} catch (error) {
  const payload = {
    ok: false,
    baseUrl,
    generatedAt: new Date().toISOString(),
    summary: { total: endpoints.length, passed: 0, failed: endpoints.length },
    error: error.message,
    results: [],
  };
  await writeFile('PLATFORM_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
}
