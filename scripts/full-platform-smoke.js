#!/usr/bin/env node
/**
 * full-platform-smoke.js
 *
 * Release-gate smoke test for the whole API surface. Boots server.js on a test
 * port (unless FULL_SMOKE_BASE_URL points at a running instance), then asserts
 * every critical endpoint:
 *   - responds (no network error)
 *   - is NOT a 404
 *   - returns valid JSON (never HTML, never plain text)
 *   - contains no NaN / Infinity tokens in the raw payload
 *   - contains the required top-level keys
 *
 * Writes FULL_PLATFORM_SMOKE_RESULTS.json and exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_PORT = Number(process.env.FULL_SMOKE_PORT || 18090);
const baseUrl = process.env.FULL_SMOKE_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const startedBySmoke = !process.env.FULL_SMOKE_BASE_URL;

// Endpoints required by the stabilization mission (Phase 13).
const endpoints = [
  { method: 'GET', path: '/api/version',                 keys: ['ok', 'version'] },
  { method: 'GET', path: '/api/ml/dependencies',         keys: ['ok', 'status', 'dependencies'] },
  { method: 'GET', path: '/api/ml/model',                keys: ['ok', 'champion', 'status'] },
  { method: 'GET', path: '/api/ml/model-runs',           keys: ['ok', 'runs'] },
  { method: 'GET', path: '/api/ml/drift',                keys: ['ok', 'drift'] },
  { method: 'GET', path: '/api/ml/predictions',          keys: ['ok', 'predictions'] },
  { method: 'GET', path: '/api/ml/feature-importance',   keys: ['ok', 'features'] },
  { method: 'GET', path: '/api/ml/model-card',           keys: ['ok', 'modelCard', 'status'], headers: { accept: 'application/json' } },
  { method: 'GET', path: '/api/historical/providers',    keys: ['ok', 'providers'] },
  { method: 'GET', path: '/api/historical/datasets',     keys: ['ok', 'datasets'] },
  { method: 'GET', path: '/api/providers/health',        keys: ['providers'] },
  { method: 'GET', path: '/api/providers/active',        keys: ['activeProviders'] },
  { method: 'GET', path: '/api/feed/status',             keys: ['providers'] },
  { method: 'GET', path: '/api/portfolio/summary',       keys: ['ok'] },
  { method: 'GET', path: '/api/risk/summary',            keys: ['ok'] },
  { method: 'GET', path: '/api/macro/correlation?symbols=SPY,QQQ', keys: ['ok', 'status'] },
  { method: 'GET', path: '/api/macro/beta?asset=QQQ&benchmark=SPY', keys: ['ok', 'status'] },
  // Negative control: an unknown /api route must return a JSON endpoint_not_found,
  // never an HTML 404 page.
  { method: 'GET', path: '/api/__does_not_exist__', expect404Json: true, keys: ['ok', 'status'] },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return true;
    } catch { /* retry */ }
    await wait(250);
  }
  return false;
}

// Detect bare NaN / Infinity tokens that JSON.parse would reject anyway, but
// also catch them if a route stringifies manually. JSON.parse already throws on
// raw NaN/Infinity, so this is a belt-and-suspenders check on the raw text.
function hasNonFiniteToken(text) {
  return /(?<![\w"])(NaN|-?Infinity)(?![\w"])/.test(text);
}

function looksLikeHtml(text, contentType) {
  if (/text\/html/i.test(contentType)) return true;
  const head = text.trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

async function runEndpoint(endpoint) {
  const startedAt = Date.now();
  const fail = (error, extra = {}) => ({ ...endpoint, ok: false, durationMs: Date.now() - startedAt, error, ...extra });
  try {
    const response = await fetch(`${baseUrl}${endpoint.path}`, {
      method: endpoint.method,
      headers: { 'content-type': 'application/json', ...(endpoint.headers || {}) },
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (looksLikeHtml(text, contentType)) return fail('html_response', { status: response.status, contentType });
    if (hasNonFiniteToken(text))          return fail('non_finite_token', { status: response.status });

    let body;
    try { body = text ? JSON.parse(text) : null; }
    catch (e) { return fail(`invalid_json: ${e.message}`, { status: response.status }); }

    // Negative control: unknown route should be a JSON 404, not a hard pass/fail on 404.
    if (endpoint.expect404Json) {
      const okShape = response.status === 404 && body && body.ok === false && typeof body.status === 'string';
      return { ...endpoint, status: response.status, ok: okShape, durationMs: Date.now() - startedAt, bodyStatus: body?.status || null };
    }

    if (response.status === 404) return fail('unexpected_404', { status: 404 });

    const missingKeys = (endpoint.keys || []).filter((key) => !Object.hasOwn(body || {}, key));
    return {
      ...endpoint,
      status: response.status,
      ok: missingKeys.length === 0,
      durationMs: Date.now() - startedAt,
      missingKeys,
      bodyStatus: body?.status ?? null,
    };
  } catch (error) {
    return fail(error.message, { status: null });
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
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const payload = {
    ok: failed === 0,
    baseUrl,
    generatedAt: new Date().toISOString(),
    summary: { total: results.length, passed, failed },
    results,
  };
  await writeFile('FULL_PLATFORM_SMOKE_RESULTS.json', `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload.summary, null, 2));
  if (failed) {
    console.error('FAILURES:', JSON.stringify(results.filter((r) => !r.ok), null, 2));
    process.exitCode = 1;
  }
} catch (error) {
  await writeFile('FULL_PLATFORM_SMOKE_RESULTS.json', `${JSON.stringify({ ok: false, baseUrl, error: error.message }, null, 2)}\n`);
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGTERM');
}
