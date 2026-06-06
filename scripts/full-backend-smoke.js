#!/usr/bin/env node
/**
 * Full backend release-gate smoke.
 * Verifies required production API contracts are mounted, JSON-only, and free of
 * raw NaN/Infinity tokens. Writes FULL_BACKEND_SMOKE_RESULTS.json.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_PORT = Number(process.env.FULL_BACKEND_PORT || 18095);
const baseUrl = process.env.FULL_BACKEND_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const startedBySmoke = !process.env.FULL_BACKEND_BASE_URL;

const endpoints = [
  { method: 'GET', path: '/api/version', keys: ['ok', 'version'] },
  { method: 'GET', path: '/api/ml/dependencies', keys: ['ok', 'status', 'dependencies'] },
  { method: 'GET', path: '/api/ml/health', keys: ['ok', 'status', 'worker'] },
  { method: 'GET', path: '/api/ml/model', keys: ['ok', 'champion', 'status'] },
  { method: 'GET', path: '/api/ml/model-runs', keys: ['ok', 'runs'] },
  { method: 'GET', path: '/api/ml/predictions', keys: ['ok', 'predictions', 'status'] },
  { method: 'GET', path: '/api/ml/feature-importance', keys: ['ok', 'features', 'status'] },
  { method: 'GET', path: '/api/ml/drift', keys: ['ok', 'drift'] },
  { method: 'GET', path: '/api/ml/model-card', keys: ['ok', 'modelCard', 'status'] },
  { method: 'POST', path: '/api/ml/train', body: { symbol: 'SPY', timeframe: '1d', horizon: 10, modelType: 'XGBoost', promote: false }, expectStatusAny: [200, 400], keys: ['ok', 'status'] },
  { method: 'POST', path: '/api/ml/infer/SPY', body: {}, expectStatusAny: [200, 400, 422], keys: ['ok', 'status'] },
  { method: 'POST', path: '/api/ml/promote/__smoke_missing_model__', expectStatusAny: [200, 404], keys: ['ok', 'status'] },

  { method: 'GET', path: '/api/historical/providers', keys: ['ok', 'providers'] },
  { method: 'GET', path: '/api/historical/datasets', keys: ['ok', 'datasets'] },
  { method: 'GET', path: '/api/historical/datasets/__smoke_missing_dataset__', expectStatusAny: [200, 404], keys: ['ok', 'status'] },
  { method: 'GET', path: '/api/historical/datasets/__smoke_missing_dataset__/diagnostics', expectStatusAny: [200, 404], keys: ['ok'] },
  { method: 'POST', path: '/api/historical/download', body: { symbols: [], provider: 'yahoo', timeframe: '1d' }, expectStatus: 400, keys: ['ok', 'status'] },
  { method: 'POST', path: '/api/historical/use-for-ml', body: {}, expectStatus: 400, keys: ['ok', 'status'] },
  { method: 'POST', path: '/api/historical/use-for-backtest', body: {}, expectStatus: 400, keys: ['ok', 'status'] },
  { method: 'POST', path: '/api/historical/use-for-correlation', body: {}, expectStatus: 400, keys: ['ok', 'status'] },

  { method: 'POST', path: '/api/backtest/run', body: { symbol: 'SPY', datasetId: '__smoke_missing_dataset__' }, expectStatusAny: [200, 404], keys: ['ok', 'status'] },
  { method: 'GET', path: '/api/backtest/runs', keys: ['ok', 'runs'] },
  { method: 'GET', path: '/api/backtest/runs/__smoke_missing_run__', keys: ['ok', 'runs'] },

  { method: 'GET', path: '/api/macro/correlation?symbols=SPY,QQQ&window=20&timeframe=1d', keys: ['ok', 'status'] },
  { method: 'GET', path: '/api/macro/beta?asset=QQQ&benchmark=SPY&window=20', keys: ['ok', 'status'] },
  { method: 'GET', path: '/api/macro/sector-rotation?window=20&timeframe=1d&benchmark=SPY', keys: ['ok', 'sectors', 'status'] },
  { method: 'GET', path: '/api/macro/volatility-heatmap?symbols=SPY,QQQ&window=20&timeframe=1d', keys: ['ok', 'symbols', 'heatmap', 'status'] },

  { method: 'GET', path: '/api/providers/health', keys: ['providers'] },
  { method: 'GET', path: '/api/providers/credentials', keys: ['ok', 'credentials'] },
  { method: 'GET', path: '/api/providers/active', keys: ['activeProviders'] },
  { method: 'GET', path: '/api/feed/status', keys: ['providers'] },
  { method: 'GET', path: '/api/feeds/tick/SPY', keys: ['success'] },
  { method: 'GET', path: '/api/feeds/candle/SPY', keys: ['success'] },
  { method: 'GET', path: '/api/feeds/orderbook/SPY', keys: ['success'] },

  { method: 'GET', path: '/api/portfolio/summary', keys: ['ok'] },
  { method: 'GET', path: '/api/portfolio/positions', keys: ['ok'] },
  { method: 'GET', path: '/api/portfolio/pnl', keys: ['ok'] },
  { method: 'GET', path: '/api/portfolio/exposure', keys: ['ok'] },
  { method: 'GET', path: '/api/portfolio/drawdown', keys: ['ok'] },
  { method: 'GET', path: '/api/portfolio/history', keys: ['ok'] },
  { method: 'GET', path: '/api/risk/summary', keys: ['ok'] },
  { method: 'GET', path: '/api/risk/limits', keys: ['ok'] },
  { method: 'GET', path: '/api/risk/var', keys: ['ok'] },
  { method: 'GET', path: '/api/risk/drawdown', keys: ['ok'] },
  { method: 'GET', path: '/api/risk/exposure', keys: ['ok'] },
  { method: 'GET', path: '/api/risk/alerts', keys: ['ok'] },

  { method: 'GET', path: '/api/__unknown__', expect404Json: true, keys: ['ok', 'status', 'endpoint', 'method'] },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try { if ((await fetch(`${url}/health`)).ok) return true; } catch { /* retry */ }
    await wait(250);
  }
  return false;
}

function hasNonFiniteToken(text) {
  return /(?<![\w"])(NaN|-?Infinity)(?![\w"])/.test(text);
}

function looksLikeHtml(text, contentType) {
  if (/text\/html/i.test(contentType)) return true;
  const head = text.trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

async function runEndpoint(ep) {
  const startedAt = Date.now();
  const fail = (error, extra = {}) => ({ ...ep, ok: false, durationMs: Date.now() - startedAt, error, ...extra });
  try {
    const response = await fetch(`${baseUrl}${ep.path}`, {
      method: ep.method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(Object.hasOwn(ep, 'body') ? { body: JSON.stringify(ep.body) } : {}),
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (looksLikeHtml(text, contentType)) return fail('html_response', { status: response.status, contentType });
    if (!/application\/json/i.test(contentType)) return fail('non_json_content_type', { status: response.status, contentType });
    if (hasNonFiniteToken(text)) return fail('non_finite_token', { status: response.status });

    let body;
    try { body = text ? JSON.parse(text) : null; }
    catch (e) { return fail(`invalid_json: ${e.message}`, { status: response.status }); }

    if (ep.expect404Json) {
      const ok = response.status === 404 && body && body.ok === false && typeof body.status === 'string';
      const missingKeys = (ep.keys || []).filter((k) => !Object.hasOwn(body || {}, k));
      return { ...ep, status: response.status, ok: ok && missingKeys.length === 0, durationMs: Date.now() - startedAt, missingKeys, bodyStatus: body?.status ?? null };
    }
    if (ep.expectStatus && response.status !== ep.expectStatus) return fail(`unexpected_status_${response.status}`, { status: response.status, bodyStatus: body?.status ?? null });
    if (ep.expectStatusAny && !ep.expectStatusAny.includes(response.status)) return fail(`unexpected_status_${response.status}`, { status: response.status, bodyStatus: body?.status ?? null });
    if (!ep.expectStatus && !ep.expectStatusAny && response.status === 404) return fail('unexpected_404', { status: 404, bodyStatus: body?.status ?? null });

    const missingKeys = (ep.keys || []).filter((k) => !Object.hasOwn(body || {}, k));
    return { ...ep, status: response.status, ok: missingKeys.length === 0, durationMs: Date.now() - startedAt, missingKeys, bodyStatus: body?.status ?? null };
  } catch (error) {
    return fail(error.message, { status: null });
  }
}

let child = null;
try {
  if (startedBySmoke) {
    child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(DEFAULT_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => process.stdout.write(`[server] ${c}`));
    child.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
    if (!(await waitForServer(baseUrl))) throw new Error(`Server did not become healthy at ${baseUrl}`);
  }

  const results = [];
  for (const ep of endpoints) results.push(await runEndpoint(ep));
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const payload = { ok: failed === 0, baseUrl, generatedAt: new Date().toISOString(), summary: { total: results.length, passed, failed }, results };
  await writeFile('FULL_BACKEND_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (failed) {
    console.error('FAILURES:', JSON.stringify(results.filter((r) => !r.ok), null, 2));
    process.exitCode = 1;
  }
} catch (error) {
  await writeFile('FULL_BACKEND_SMOKE_RESULTS.json', `${JSON.stringify({ ok: false, baseUrl, error: error.message }, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
}
