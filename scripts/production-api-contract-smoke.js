#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_ROUTES, concretePath } from './backend-contract-routes.js';

const root = process.cwd();
const baseUrl = process.env.API_BASE;
const timeoutMs = Number(process.env.PRODUCTION_API_TIMEOUT_MS || 15000);
const sample = REQUIRED_ROUTES.filter((ep) => ep.method === 'GET' || ['/api/ml/infer/:symbol','/api/backtest/run','/api/historical/use-for-ml'].includes(ep.route));
const bodyByRoute = new Map([
  ['/api/ml/infer/:symbol', {}],
  ['/api/backtest/run', {}],
  ['/api/historical/use-for-ml', {}],
]);
const queryByRoute = new Map([
  ['/api/macro/beta', '?asset=QQQ&benchmark=SPY&window=20'],
  ['/api/macro/correlation', '?symbols=SPY,QQQ&window=20&timeframe=1d'],
]);
function hasNonFiniteToken(text) { return /(?<![\w"])(NaN|-?Infinity|undefined)(?![\w"])/.test(text); }
function looksLikeHtml(text, ct) { return /text\/html/i.test(ct) || /^\s*(<!doctype|<html)/i.test(text); }
async function call(ep) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); const url = `${concretePath(ep.route)}${queryByRoute.get(ep.route) || ''}`; const errors = [];
  try {
    const response = await fetch(`${baseUrl}${url}`, { method: ep.method, headers: { accept: 'application/json', 'content-type': 'application/json' }, ...(bodyByRoute.has(ep.route) ? { body: JSON.stringify(bodyByRoute.get(ep.route)) } : {}), signal: controller.signal });
    const ct = response.headers.get('content-type') || ''; const text = await response.text(); let body = null; let validJson = false;
    try { body = text ? JSON.parse(text) : null; validJson = text.length > 0; } catch { errors.push('invalid_json'); }
    if (response.status === 404) errors.push('route_404');
    if (response.status >= 500) errors.push('server_error');
    if (!/application\/json/i.test(ct)) errors.push('non_json_content_type');
    if (looksLikeHtml(text, ct)) errors.push('html_response');
    if (hasNonFiniteToken(text)) errors.push('non_finite_or_undefined_token');
    if (!body || (!Object.hasOwn(body, 'ok') && !Object.hasOwn(body, 'success'))) errors.push('missing_expected_top_level_key');
    return { method: ep.method, url, httpStatus: response.status, contentType: ct, validJson, preview: text.slice(0, 500), errors };
  } catch (err) {
    return { method: ep.method, url, httpStatus: null, contentType: null, validJson: false, preview: '', errors: [err.name === 'AbortError' ? 'network_timeout' : `network_fail:${err.message}`] };
  } finally { clearTimeout(timer); }
}
async function main() {
  if (!baseUrl) {
    const output = { ok: true, skipped: true, generatedAt: new Date().toISOString(), reason: 'API_BASE not provided', ciCommand: 'API_BASE=https://reversal.onrender.com node scripts/production-api-contract-smoke.js' };
    await writeFile(path.join(root, 'PRODUCTION_API_CONTRACT_SMOKE_RESULTS.json'), JSON.stringify(output, null, 2));
    console.log('Production API contract smoke skipped: API_BASE not provided.');
    return;
  }
  const results = [];
  for (const ep of sample) results.push(await call(ep));
  const failing = results.filter((r) => r.errors.length);
  const output = { ok: failing.length === 0, skipped: false, generatedAt: new Date().toISOString(), baseUrl, total: results.length, failingCount: failing.length, endpoints: results };
  await writeFile(path.join(root, 'PRODUCTION_API_CONTRACT_SMOKE_RESULTS.json'), JSON.stringify(output, null, 2));
  if (failing.length) { console.error(`Production contract smoke failed: ${failing.length}/${results.length}`); for (const r of failing) console.error(`${r.method} ${r.url}: ${r.errors.join(', ')}`); process.exit(1); }
  console.log(`Production API contract smoke passed against ${baseUrl}.`);
}
main().catch((err) => { console.error(err); process.exit(1); });
