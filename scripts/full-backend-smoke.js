#!/usr/bin/env node
/**
 * full-backend-smoke.js
 *
 * Backend release-gate smoke (Phase 10). Boots server.js on a test port (unless
 * FULL_BACKEND_BASE_URL points at a running instance), then asserts every
 * critical endpoint:
 *   - responds (no network error) and is NOT a 404 (except the negative control)
 *   - returns valid JSON, never HTML, never plain text
 *   - contains no NaN / Infinity tokens
 *   - contains the required top-level keys
 *
 * Writes FULL_BACKEND_SMOKE_RESULTS.json; exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_PORT = Number(process.env.FULL_BACKEND_PORT || 18095);
const baseUrl = process.env.FULL_BACKEND_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const startedBySmoke = !process.env.FULL_BACKEND_BASE_URL;

const endpoints = [
  { method: 'GET', path: '/api/version',               keys: ['ok', 'version'] },
  { method: 'GET', path: '/api/ml/dependencies',       keys: ['ok', 'status', 'dependencies'] },
  { method: 'GET', path: '/api/ml/model',              keys: ['ok', 'champion', 'status'] },
  { method: 'GET', path: '/api/ml/model-runs',         keys: ['ok', 'runs'] },
  { method: 'GET', path: '/api/ml/drift',              keys: ['ok', 'drift'] },
  { method: 'GET', path: '/api/historical/providers',  keys: ['ok', 'providers'] },
  { method: 'GET', path: '/api/historical/datasets',   keys: ['ok', 'datasets'] },
  { method: 'GET', path: '/api/providers/health',      keys: ['providers'] },
  { method: 'GET', path: '/api/providers/active',      keys: ['activeProviders'] },
  { method: 'GET', path: '/api/feed/status',           keys: ['providers'] },
  { method: 'GET', path: '/api/portfolio/summary',     keys: ['ok'] },
  { method: 'GET', path: '/api/risk/summary',          keys: ['ok'] },
  { method: 'GET', path: '/api/macro/correlation?symbols=SPY,QQQ&window=20&timeframe=1d', keys: ['ok', 'status'] },
  { method: 'GET', path: '/api/macro/beta?asset=QQQ&benchmark=SPY&window=20', keys: ['ok', 'status'] },
  // Negative controls: must be JSON, not HTML.
  { method: 'GET',  path: '/api/__unknown__', expect404Json: true, keys: ['ok', 'status'] },
  { method: 'POST', path: '/api/historical/use-for-ml', body: {}, expectStatus: 400, keys: ['ok', 'status'] },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, attempts = 60) {
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
      ...(ep.body ? { body: JSON.stringify(ep.body) } : {}),
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (looksLikeHtml(text, contentType)) return fail('html_response', { status: response.status });
    if (hasNonFiniteToken(text))          return fail('non_finite_token', { status: response.status });

    let body;
    try { body = text ? JSON.parse(text) : null; }
    catch (e) { return fail(`invalid_json: ${e.message}`, { status: response.status }); }

    if (ep.expect404Json) {
      const ok = response.status === 404 && body && body.ok === false && typeof body.status === 'string';
      return { ...ep, status: response.status, ok, durationMs: Date.now() - startedAt, bodyStatus: body?.status ?? null };
    }
    if (ep.expectStatus && response.status !== ep.expectStatus) {
      return fail(`unexpected_status_${response.status}`, { status: response.status });
    }
    if (!ep.expectStatus && response.status === 404) return fail('unexpected_404', { status: 404 });

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
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
}
