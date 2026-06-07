#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_ROUTES, concretePath } from './backend-contract-routes.js';

const root = process.cwd();
const port = Number(process.env.API_CONTRACT_PORT || 18101);
const baseUrl = process.env.API_BASE_LOCAL || `http://127.0.0.1:${port}`;
const startedByCrawler = !process.env.API_BASE_LOCAL;
const timeoutMs = Number(process.env.API_CONTRACT_TIMEOUT_MS || 12000);

const bodyByPath = new Map([
  ['/api/ml/train', { symbol: 'SPY', timeframe: '1d', horizon: 10, datasetId: '__contract_missing_dataset__', modelType: 'xgboost', promote: false }],
  ['/api/ml/promote/:modelId', {}],
  ['/api/ml/infer/:symbol', {}],
  ['/api/historical/download', { provider: 'yahoo', symbols: [], timeframe: '1d', startDate: '2021-01-01', endDate: '2026-06-06', purpose: 'general' }],
  ['/api/historical/use-for-ml', {}],
  ['/api/historical/use-for-backtest', {}],
  ['/api/historical/use-for-correlation', {}],
  ['/api/backtest/run', {}],
  ['/api/providers/credentials/:providerId', { apiKey: '' }],
  ['POST /api/providers/active', { providers: [], providerOrder: [] }],
]);
const queryByPath = new Map([
  ['/api/macro/beta', '?asset=QQQ&benchmark=SPY&window=20'],
  ['/api/macro/correlation', '?symbols=SPY,QQQ&window=20&timeframe=1d'],
  ['/api/macro/sector-rotation', '?window=20&timeframe=1d&benchmark=SPY'],
  ['/api/macro/volatility-heatmap', '?symbols=SPY,QQQ&window=20&timeframe=1d'],
]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return true; } catch {}
    await wait(250);
  }
  return false;
}
function hasNonFiniteToken(text) { return /(?<![\w"])(NaN|-?Infinity|undefined)(?![\w"])/.test(text); }
function looksLikeHtml(text, ct) { return /text\/html/i.test(ct) || /^\s*(<!doctype|<html)/i.test(text); }
function expectedStatuses(route, method) {
  if (method === 'POST') return [200, 400, 404, 422];
  if (route.includes('__contract_missing') || route.includes('__contract_invalid_provider__')) return [200, 400, 404];
  return [200];
}
async function callEndpoint(ep) {
  const startedAt = Date.now();
  const urlPath = `${concretePath(ep.route)}${queryByPath.get(ep.route) || ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const errors = [];
  try {
    const bodyKey = `${ep.method} ${ep.route}`;
    const requestBody = bodyByPath.get(bodyKey) ?? bodyByPath.get(ep.route);
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method: ep.method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      ...(requestBody !== undefined && !['GET', 'HEAD'].includes(ep.method) ? { body: JSON.stringify(requestBody) } : {}),
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let body = null; let validJson = false;
    try { body = text ? JSON.parse(text) : null; validJson = text.length > 0; } catch { errors.push('invalid_json'); }
    if (looksLikeHtml(text, contentType)) errors.push('html_response');
    if (!/application\/json/i.test(contentType)) errors.push('non_json_content_type');
    if (response.status === 404 && ep.method === 'GET' && !urlPath.includes('__contract_missing')) errors.push('required_route_404');
    if (response.status >= 500) errors.push('server_error');
    if (response.status === 200 && !text.trim()) errors.push('empty_success_body');
    if (hasNonFiniteToken(text)) errors.push('non_finite_or_undefined_token');
    if (!expectedStatuses(urlPath, ep.method).includes(response.status) && !(ep.method === 'DELETE' && response.status === 400)) errors.push(`unexpected_status_${response.status}`);
    const shapeOk = validJson && body && (Object.hasOwn(body, 'ok') || Object.hasOwn(body, 'success'));
    if (!shapeOk) errors.push('missing_ok_or_success');
    return { method: ep.method, url: urlPath, status: response.status, contentType, validJson, responsePreview: text.slice(0, 500), shapeOk, durationMs: Date.now() - startedAt, errors };
  } catch (err) {
    return { method: ep.method, url: urlPath, status: null, contentType: null, validJson: false, responsePreview: '', shapeOk: false, durationMs: Date.now() - startedAt, errors: [err.name === 'AbortError' ? 'timeout' : `network_error:${err.message}`] };
  } finally { clearTimeout(timer); }
}

let child = null;
async function main() {
  if (startedByCrawler) {
    child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    if (!(await waitForServer())) throw new Error('local backend did not become healthy');
  }
  const results = [];
  for (const ep of REQUIRED_ROUTES) results.push(await callEndpoint(ep));
  const failing = results.filter((r) => r.errors.length);
  const output = { ok: failing.length === 0, generatedAt: new Date().toISOString(), baseUrl, timeoutMs, total: results.length, failingCount: failing.length, endpoints: results };
  await writeFile(path.join(root, 'API_CONTRACT_CRAWLER_RESULTS.json'), JSON.stringify(output, null, 2));
  if (failing.length) {
    console.error(`API contract crawler failed: ${failing.length}/${results.length} endpoints failed`);
    for (const r of failing) console.error(`${r.method} ${r.url}: ${r.errors.join(', ')}`);
    process.exit(1);
  }
  console.log(`API contract crawler passed: ${results.length} endpoints JSON-safe.`);
}
main().catch((err) => { console.error(err); process.exit(1); }).finally(() => { if (child) child.kill('SIGTERM'); });
