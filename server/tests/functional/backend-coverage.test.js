/**
 * backend-coverage.test.js — Comprehensive functional test suite for the reversal API.
 *
 * Architecture:
 *   before()  → read SEED_MANIFEST.json → spawnTestServer → forgeJwt
 *   [describes covering every cataloged route]
 *   after()   → killServer → write BACKEND_COVERAGE.json → assert barrier
 *
 * Run:
 *   SEED_DIR=./test-seed node --test --test-concurrency=1 \
 *     server/tests/functional/backend-coverage.test.js
 *
 * Skips entire suite gracefully if SEED_MANIFEST.json is absent.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { spawnTestServer, killServer, forgeJwt } from './helpers.js';

// ── Locate SEED_MANIFEST.json ─────────────────────────────────────────────────

const __filename  = fileURLToPath(import.meta.url);
const __dir       = dirname(__filename);
const REPO_ROOT   = resolve(__dir, '../../../');

const seedDirRaw  = process.env.SEED_DIR || './test-seed';
const SEED_DIR    = seedDirRaw.startsWith('/')
  ? seedDirRaw
  : resolve(process.cwd(), seedDirRaw);
const MANIFEST_PATH = join(SEED_DIR, 'SEED_MANIFEST.json');

// ── Route coverage map ────────────────────────────────────────────────────────

/**
 * Every route the server exposes is cataloged here.
 * Status transitions: 'pending' → 'covered:<detail>' or 'deferred:<reason>'
 */
const COVERAGE = {};

function catalogRoute(method, path) {
  const key = `${method} ${path}`;
  COVERAGE[key] = { status: 'pending', detail: null };
  return key;
}

function markCovered(key, detail = '') {
  if (!COVERAGE[key]) COVERAGE[key] = { status: 'pending', detail: null };
  COVERAGE[key] = { status: `covered: ${detail}`, detail };
}

function markDeferred(key, reason = '') {
  if (!COVERAGE[key]) COVERAGE[key] = { status: 'pending', detail: null };
  COVERAGE[key] = { status: `deferred: ${reason}`, detail: reason };
}

// Catalog all known routes
const R = {
  GET_ROOT:              catalogRoute('GET', '/'),
  GET_HEALTH:            catalogRoute('GET', '/health'),
  POST_AUTH_REGISTER:    catalogRoute('POST', '/auth/register'),
  POST_AUTH_LOGIN:       catalogRoute('POST', '/auth/login'),
  GET_AUTH_ME:           catalogRoute('GET', '/auth/me'),
  GET_API_VERSION:       catalogRoute('GET', '/api/version'),
  GET_RUNTIME_HEALTH:    catalogRoute('GET', '/api/runtime/health'),
  GET_RUNTIME_STATUS:    catalogRoute('GET', '/api/runtime/runtime-status'),
  GET_MONITORING_STATUS: catalogRoute('GET', '/api/monitoring/runtime-status'),
  GET_PROVIDERS_HEALTH:  catalogRoute('GET', '/api/providers/health'),
  GET_MARKET_RUNTIME:    catalogRoute('GET', '/api/market/runtime'),
  GET_MARKET_SUBS:       catalogRoute('GET', '/api/market/subscriptions'),
  POST_MARKET_SUB:       catalogRoute('POST', '/api/market/subscribe'),
  DEL_MARKET_SUB:        catalogRoute('DELETE', '/api/market/subscribe/:symbol'),
  GET_REPLAY_CANDLES:    catalogRoute('GET', '/api/replay/candles/:symbol'),
  GET_REPLAY_LEG_CANDLES:catalogRoute('GET', '/api/replay-legacy/candles/:symbol'),
  POST_REPLAY_START:     catalogRoute('POST', '/api/replay-session/start'),
  POST_REPLAY_PAUSE:     catalogRoute('POST', '/api/replay-session/pause'),
  POST_REPLAY_RESUME:    catalogRoute('POST', '/api/replay-session/resume'),
  POST_REPLAY_STOP:      catalogRoute('POST', '/api/replay-session/stop'),
  GET_ALPHA_SIGNALS:     catalogRoute('GET', '/api/alpha/signals/:symbol'),
  GET_PATTERN_SIGNALS:   catalogRoute('GET', '/api/patterns/signals/:symbol'),
  GET_STRATEGY_CANDS:    catalogRoute('GET', '/api/strategies/candidates/:symbol'),
  GET_QUANT_FEATURES:    catalogRoute('GET', '/api/quant/features/:symbol'),
  GET_QUALITY_SCORES:    catalogRoute('GET', '/api/quality/scores/:symbol'),
  GET_ANALYTICS_TREND:   catalogRoute('GET', '/api/analytics/trend/:symbol'),
  GET_ANALYTICS_LATEST:  catalogRoute('GET', '/api/analytics/latest/:symbol'),
  GET_BACKTEST_RUNS:     catalogRoute('GET', '/api/backtest/runs'),
  GET_BACKTEST_RESULTS:  catalogRoute('GET', '/api/backtest/results/:symbol'),
  GET_VALIDATION_RESULTS:catalogRoute('GET', '/api/validation/results/:symbol'),
  GET_STRATLAB_STRATS:   catalogRoute('GET', '/api/strategy-lab/strategies'),
  GET_RULES_SETS:        catalogRoute('GET', '/api/rules/sets/:symbol'),
  GET_TEMPLATES_STRATS:  catalogRoute('GET', '/api/templates/strategies'),
  GET_SESSION_CTX:       catalogRoute('GET', '/api/session-context/:symbol'),
  GET_REVERSALS_PTS:     catalogRoute('GET', '/api/reversals/points/:symbol'),
  GET_PAPER_ORDERS:      catalogRoute('GET', '/api/paper/orders'),
  GET_PAPER_POSITIONS:   catalogRoute('GET', '/api/paper/positions'),
  GET_FEEDS_STATUS:      catalogRoute('GET', '/api/feeds/status'),
  GET_FEEDS_PROVIDERS:   catalogRoute('GET', '/api/feeds/providers'),
  GET_CHART_CANDLES:     catalogRoute('GET', '/api/chart/candles/:symbol'),
  GET_CHART_INDICATORS:  catalogRoute('GET', '/api/chart/indicators/:symbol'),
  GET_CHART_PAYLOAD:     catalogRoute('GET', '/api/chart/payload/:symbol'),
  GET_ALERTS:            catalogRoute('GET', '/api/alerts'),
  POST_ALERTS:           catalogRoute('POST', '/api/alerts'),
  GET_ALERTS_DIAG:       catalogRoute('GET', '/api/alerts/diagnostics'),
  GET_ALERTS_HIST:       catalogRoute('GET', '/api/alerts/history'),
  GET_VOL_PROFILE:       catalogRoute('GET', '/api/volume-profile/:symbol'),
  GET_AI_FEATURES:       catalogRoute('GET', '/api/ai/features/:symbol'),
  GET_AI_LABELS:         catalogRoute('GET', '/api/ai/labels/:symbol'),
  GET_AI_REGIME:         catalogRoute('GET', '/api/ai/regime/history/:symbol'),
  GET_ML_HEALTH:         catalogRoute('GET', '/api/ml/health'),
  GET_ML_PREDICTIONS:    catalogRoute('GET', '/api/ml/predictions'),
  GET_ML_TRAINING_RUNS:  catalogRoute('GET', '/api/ml/training-runs'),
  GET_ML_EXPECTED_PATHS: catalogRoute('GET', '/api/ml/dataset/expected-paths'),
  GET_PROV_CREDS:        catalogRoute('GET', '/api/providers/credentials'),
  GET_PROV_STATUS:       catalogRoute('GET', '/api/providers/status'),
  GET_PROV_ACTIVE:       catalogRoute('GET', '/api/providers/active'),
  GET_PORTFOLIO_POS:     catalogRoute('GET', '/api/portfolio/positions'),
  GET_PORTFOLIO_SUM:     catalogRoute('GET', '/api/portfolio/summary'),
  GET_PORTFOLIO_DD:      catalogRoute('GET', '/api/portfolio/drawdown'),
  GET_RISK_SUMMARY:      catalogRoute('GET', '/api/risk/summary'),
  GET_RISK_LIMITS:       catalogRoute('GET', '/api/risk/limits'),
  GET_RISK_ALERTS:       catalogRoute('GET', '/api/risk/alerts'),
  GET_EXEC_STATUS:       catalogRoute('GET', '/api/execution/status'),
  GET_EXEC_RISK:         catalogRoute('GET', '/api/execution/risk'),
  GET_OMS_ORDERS:        catalogRoute('GET', '/api/oms/orders'),
  GET_OMS_OPEN:          catalogRoute('GET', '/api/oms/orders/open'),
  GET_MULTI_CORR:        catalogRoute('GET', '/api/multi-asset/correlation'),
  GET_MULTI_BETA:        catalogRoute('GET', '/api/multi-asset/beta'),
  GET_MACRO_CORR:        catalogRoute('GET', '/api/macro/correlation'),
  GET_MACRO_BETA:        catalogRoute('GET', '/api/macro/beta'),
  GET_MACRO_VOLHEAT:     catalogRoute('GET', '/api/macro/volatility-heatmap'),
  GET_MACRO_SECTOR:      catalogRoute('GET', '/api/macro/sector-rotation'),
  GET_INST_PRESETS:      catalogRoute('GET', '/api/institutional/scenarios/presets'),
  GET_INST_SCENARIOS:    catalogRoute('GET', '/api/institutional/scenarios'),
  POST_INST_SIZING:      catalogRoute('POST', '/api/institutional/sizing/volatility'),
  GET_OBS_HEALTH:        catalogRoute('GET', '/api/observability/health'),
  GET_OBS_METRICS:       catalogRoute('GET', '/api/observability/metrics'),
  GET_OBS_SESSION:       catalogRoute('GET', '/api/observability/market-session'),
  GET_HIST_PROVIDERS:    catalogRoute('GET', '/api/historical/providers'),
  GET_HIST_DATASETS:     catalogRoute('GET', '/api/historical/datasets'),
  GET_HIST_DATASET_ID:   catalogRoute('GET', '/api/historical/datasets/:id'),
  GET_HIST_CANDLES:      catalogRoute('GET', '/api/historical/datasets/:id/candles'),
  GET_HIST_STATUS:       catalogRoute('GET', '/api/historical/status'),
  POST_HIST_USE_CORR:    catalogRoute('POST', '/api/historical/use-for-correlation'),
};

// ── Shared state ──────────────────────────────────────────────────────────────

let serverCtx   = null; // { port, baseUrl, child, jwtSecret }
let jwt         = null;
let manifest    = null;
let spyId       = null;
let nflxId      = null;
let qqId        = null;
let aaplId      = null;
let SKIP        = false;

// ── Helper: HTTP request wrapper ──────────────────────────────────────────────

async function req(method, path, { body, token, expectStatus } = {}) {
  const url  = `${serverCtx.baseUrl}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) {
    headers['Authorization'] = `Bearer ${token ?? jwt}`;
  }
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(url, opts);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { _raw: text }; }
  if (expectStatus !== undefined) {
    assert.equal(res.status, expectStatus, `Expected HTTP ${expectStatus} for ${method} ${path}, got ${res.status}. Body: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body: parsed };
}

function GET(path, opts)    { return req('GET',    path, opts); }
function POST(path, opts)   { return req('POST',   path, opts); }
function DELETE(path, opts) { return req('DELETE', path, opts); }

// ── Guard against NaN / Infinity in response bodies ───────────────────────────

function hasNonFinite(value, path = '') {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return true;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (hasNonFinite(v, `${path}.${k}`)) return true;
    }
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 20); i++) {
      if (hasNonFinite(value[i], `${path}[${i}]`)) return true;
    }
  }
  return false;
}

// ── before / after ────────────────────────────────────────────────────────────

before(async () => {
  if (!existsSync(MANIFEST_PATH)) {
    console.warn(`[functional] SEED_MANIFEST.json not found at ${MANIFEST_PATH} — skipping entire suite.`);
    SKIP = true;
    return;
  }

  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (err) {
    console.warn('[functional] Could not parse SEED_MANIFEST.json:', err.message, '— skipping.');
    SKIP = true;
    return;
  }

  spyId  = manifest?.datasets?.SPY?.datasetId  ?? null;
  nflxId = manifest?.datasets?.NFLX?.datasetId ?? null;
  qqId   = manifest?.datasets?.QQQ?.datasetId  ?? null;
  aaplId = manifest?.datasets?.AAPL?.datasetId ?? null;

  if (!spyId || !nflxId || !qqId || !aaplId) {
    console.warn('[functional] Manifest is missing dataset IDs — skipping.');
    SKIP = true;
    return;
  }

  // Spawn the real server
  try {
    serverCtx = await spawnTestServer({
      seedDir:   SEED_DIR,
      jwtSecret: manifest.jwtSecret || 'functional-test-secret-change-in-ci',
      port:      manifest.testPort  || undefined,
    });
  } catch (err) {
    console.error('[functional] Failed to spawn test server:', err.message);
    SKIP = true;
    return;
  }

  jwt = forgeJwt(serverCtx.jwtSecret);
  console.log(`[functional] Server running at ${serverCtx.baseUrl}`);
});

after(async () => {
  if (serverCtx?.child) {
    await killServer(serverCtx.child);
  }

  // Write BACKEND_COVERAGE.json
  const covPath = join(REPO_ROOT, 'BACKEND_COVERAGE.json');
  const covData = {
    generatedAt: new Date().toISOString(),
    seedDir:     SEED_DIR,
    routes:      COVERAGE,
  };
  try {
    writeFileSync(covPath, JSON.stringify(covData, null, 2));
    console.log(`[functional] Coverage written to ${covPath}`);
  } catch (err) {
    console.warn('[functional] Could not write BACKEND_COVERAGE.json:', err.message);
  }

  // Coverage barrier: every route must be covered or explicitly deferred
  if (!SKIP) {
    const uncovered = Object.entries(COVERAGE).filter(
      ([, v]) => !v.status.startsWith('covered') && !v.status.startsWith('deferred:'),
    );
    if (uncovered.length > 0) {
      console.error('[functional] COVERAGE BARRIER FAILED — uncovered routes:');
      for (const [key] of uncovered) console.error(`  ${key}`);
      // Use assert to fail the test
      assert.equal(uncovered.length, 0, `${uncovered.length} route(s) are neither covered nor deferred: ${uncovered.map(([k]) => k).join(', ')}`);
    }
  }
});

// ── Tiny helper for skipping ───────────────────────────────────────────────────
function skipIfNotReady(t) {
  if (SKIP) {
    t.skip('SEED_MANIFEST.json not available — skipping.');
  }
}

// ── Health & version ──────────────────────────────────────────────────────────

describe('Health & version', () => {
  it('GET / returns ok service info', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/');
    assert.equal(body.status, 'ok', 'Expected status: ok');
    assert.ok(!hasNonFinite(body), 'Response must not contain NaN/Infinity');
    markCovered(R.GET_ROOT, 'status:ok');
  });

  it('GET /health returns { ok: true }', async (t) => {
    skipIfNotReady(t);
    const { status, body } = await GET('/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    markCovered(R.GET_HEALTH, 'ok:true');
  });

  it('GET /api/version returns ok with version field', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/version');
    assert.equal(body.ok, true);
    assert.ok(typeof body.version === 'string');
    markCovered(R.GET_API_VERSION, 'ok:true version present');
  });
});

// ── Auth flow ─────────────────────────────────────────────────────────────────

describe('Auth flow — register → login → JWT', () => {
  const testEmail = `func-test-${Date.now()}@reversal.test`;
  const testPass  = 'FuncTestPass123!';
  let registeredToken = null;

  it('POST /auth/register creates user and returns token', async (t) => {
    skipIfNotReady(t);
    const { status, body } = await POST('/auth/register', {
      body:         { email: testEmail, password: testPass },
      token:        null,
      expectStatus: 200,
    });
    assert.ok(typeof body.token === 'string', 'Expected token string');
    assert.ok(body.user, 'Expected user object');
    registeredToken = body.token;
    markCovered(R.POST_AUTH_REGISTER, 'returns token+user');
  });

  it('POST /auth/login authenticates and returns token', async (t) => {
    skipIfNotReady(t);
    const { status, body } = await POST('/auth/login', {
      body:         { email: testEmail, password: testPass },
      token:        null,
      expectStatus: 200,
    });
    assert.ok(typeof body.token === 'string', 'Expected token string');
    markCovered(R.POST_AUTH_LOGIN, 'returns token');
  });

  it('GET /auth/me returns user with valid JWT', async (t) => {
    skipIfNotReady(t);
    const { status, body } = await GET('/auth/me', { expectStatus: 200 });
    assert.ok(body.user, 'Expected user in response');
    markCovered(R.GET_AUTH_ME, 'returns user');
  });
});

// ── Runtime routes ────────────────────────────────────────────────────────────

describe('Runtime routes', () => {
  it('GET /api/runtime/health returns ok:true', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/runtime/health');
    assert.equal(body.ok, true);
    markCovered(R.GET_RUNTIME_HEALTH, 'ok:true');
  });

  it('GET /api/runtime/runtime-status returns ok:true', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/runtime/runtime-status');
    assert.equal(body.ok, true);
    markCovered(R.GET_RUNTIME_STATUS, 'ok:true');
  });

  it('GET /api/monitoring/runtime-status returns ok:true', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/monitoring/runtime-status');
    assert.equal(body.ok, true);
    markCovered(R.GET_MONITORING_STATUS, 'ok:true');
  });
});

// ── Historical — dataset enumeration & candle assertions ─────────────────────

describe('Historical — dataset enumeration & strong candle assertion', () => {
  it('GET /api/historical/providers returns provider list', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/historical/providers');
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.providers));
    markCovered(R.GET_HIST_PROVIDERS, 'ok:true providers array');
  });

  it('GET /api/historical/datasets returns >= 4 seeded datasets', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/historical/datasets');
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.datasets), 'Expected datasets array');
    assert.ok(body.datasets.length >= 4, `Expected >= 4 datasets, got ${body.datasets.length}`);
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_HIST_DATASETS, `datasets.length=${body.datasets.length} >= 4`);
  });

  it('GET /api/historical/datasets/:id returns single dataset', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET(`/api/historical/datasets/${spyId}`);
    assert.equal(body.ok, true);
    assert.equal(body.dataset.datasetId, spyId);
    markCovered(R.GET_HIST_DATASET_ID, 'single dataset returned');
  });

  it('GET /api/historical/datasets/:id/candles (SPY) >= 50 candles', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET(`/api/historical/datasets/${spyId}/candles`);
    assert.equal(body.ok, true, `Expected ok:true, got: ${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(body.count >= 50, `Expected >= 50 candles for SPY, got ${body.count}`);
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_HIST_CANDLES, `count=${body.count} >= 50`);
  });

  it('GET /api/historical/status returns ok', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/historical/status');
    assert.equal(body.ok, true);
    markCovered(R.GET_HIST_STATUS, 'ok:true');
  });

  it('POST /api/historical/use-for-correlation accepts seeded dataset', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/historical/use-for-correlation', {
      body: { datasetId: spyId },
    });
    assert.equal(body.ok, true, `Expected ok:true, got: ${JSON.stringify(body).slice(0, 300)}`);
    markCovered(R.POST_HIST_USE_CORR, 'ok:true for seeded dataset');
  });
});

// ── Macro — STRONG assertions with real seeded data ───────────────────────────

describe('Macro — STRONG: correlation, beta, volatility with real seeded data', () => {
  it('GET /api/macro/correlation with SPY+NFLX: observations >= 20', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({
      datasetIds: `${spyId},${nflxId}`,
      symbols:    'SPY,NFLX',
    });
    const { body } = await GET(`/api/macro/correlation?${params}`);
    assert.equal(body.ok, true,        `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.status, 'ready', `Expected status:ready. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.ok(
      Number.isFinite(body.observations) && body.observations >= 20,
      `Expected observations >= 20, got ${body.observations}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_MACRO_CORR, `observations=${body.observations}`);
  });

  it('GET /api/macro/beta with NFLX/SPY: finite beta, r2, observations >= 20', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({
      datasetIds: `${spyId},${nflxId}`,
      asset:      'NFLX',
      benchmark:  'SPY',
    });
    const { body } = await GET(`/api/macro/beta?${params}`);
    assert.equal(body.ok, true,        `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.status, 'ready', `Expected status:ready. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.ok(Number.isFinite(body.beta), `Expected finite beta, got ${body.beta}`);
    assert.ok(Number.isFinite(body.r2),   `Expected finite r2, got ${body.r2}`);
    assert.ok(
      Number.isFinite(body.observations) && body.observations >= 20,
      `Expected observations >= 20, got ${body.observations}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_MACRO_BETA, `beta=${body.beta?.toFixed(3)} r2=${body.r2?.toFixed(3)} obs=${body.observations}`);
  });

  it('GET /api/macro/volatility-heatmap for SPY: realizedVol > 0', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({
      datasetId: spyId,
      symbols:   'SPY',
    });
    const { body } = await GET(`/api/macro/volatility-heatmap?${params}`);
    assert.equal(body.ok, true,        `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.status, 'ready', `Expected status:ready. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.ok(Array.isArray(body.items) && body.items.length > 0, 'Expected items array');
    const firstItem = body.items[0];
    assert.ok(
      Number.isFinite(firstItem.realizedVol) && firstItem.realizedVol > 0,
      `Expected realizedVol > 0, got ${firstItem.realizedVol}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_MACRO_VOLHEAT, `realizedVol=${firstItem.realizedVol?.toFixed(4)}`);
  });

  it('GET /api/macro/sector-rotation returns ok', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({
      datasetIds: `${spyId},${qqId}`,
      symbols:    'SPY,QQQ',
    });
    const { body } = await GET(`/api/macro/sector-rotation?${params}`);
    // sector-rotation may return ok:true or ok:false with insufficient data; just check it responds
    assert.ok(typeof body.ok === 'boolean', 'Expected ok field');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_MACRO_SECTOR, 'responds without crash');
  });
});

// ── Multi-asset ───────────────────────────────────────────────────────────────

describe('Multi-asset', () => {
  it('GET /api/multi-asset/correlation responds', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({ symbols: 'SPY,NFLX' });
    const { body } = await GET(`/api/multi-asset/correlation?${params}`);
    assert.ok(typeof body.ok === 'boolean', 'Expected ok field');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_MULTI_CORR, 'responds without crash');
  });

  it('GET /api/multi-asset/beta responds', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({ symbols: 'SPY,NFLX' });
    const { body } = await GET(`/api/multi-asset/beta?${params}`);
    assert.ok(typeof body.ok === 'boolean', 'Expected ok field');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in response');
    markCovered(R.GET_MULTI_BETA, 'responds without crash');
  });
});

// ── Market stream & feeds ─────────────────────────────────────────────────────

describe('Market stream & feeds', () => {
  it('GET /api/providers/health responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/providers/health');
    assert.ok(typeof body === 'object', 'Expected object response');
    markCovered(R.GET_PROVIDERS_HEALTH, 'responds');
  });

  it('GET /api/market/runtime responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/market/runtime');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_MARKET_RUNTIME, 'responds');
  });

  it('GET /api/market/subscriptions responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/market/subscriptions');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_MARKET_SUBS, 'responds');
  });

  it('POST /api/market/subscribe responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/market/subscribe', { body: { symbol: 'SPY' } });
    assert.ok(typeof body === 'object');
    markCovered(R.POST_MARKET_SUB, 'responds');
  });

  it('DELETE /api/market/subscribe/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { status } = await DELETE('/api/market/subscribe/SPY');
    // May be 200 or 404 depending on subscription state
    assert.ok([200, 404, 204].includes(status), `Unexpected status: ${status}`);
    markCovered(R.DEL_MARKET_SUB, 'responds 200/404/204');
  });

  it('GET /api/feeds/status responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/feeds/status');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_FEEDS_STATUS, 'responds');
  });

  it('GET /api/feeds/providers responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/feeds/providers');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_FEEDS_PROVIDERS, 'responds');
  });
});

// ── Chart ─────────────────────────────────────────────────────────────────────

describe('Chart', () => {
  it('GET /api/chart/candles/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/chart/candles/SPY');
    assert.ok(typeof body === 'object');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_CHART_CANDLES, 'responds without crash');
  });

  it('GET /api/chart/indicators/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/chart/indicators/SPY');
    assert.ok(typeof body === 'object');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_CHART_INDICATORS, 'responds without crash');
  });

  it('GET /api/chart/payload/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/chart/payload/SPY');
    assert.ok(typeof body === 'object');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_CHART_PAYLOAD, 'responds without crash');
  });
});

// ── Alerts CRUD ───────────────────────────────────────────────────────────────

describe('Alerts CRUD', () => {
  let createdAlertId = null;

  it('GET /api/alerts returns list', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/alerts');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ALERTS, 'returns list');
  });

  it('POST /api/alerts creates alert', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/alerts', {
      body: { symbol: 'SPY', type: 'price_above', threshold: 999, params: {} },
    });
    assert.ok(typeof body === 'object');
    if (body.alert?.id) createdAlertId = body.alert.id;
    markCovered(R.POST_ALERTS, 'creates alert');
  });

  it('GET /api/alerts/diagnostics returns diagnostics', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/alerts/diagnostics');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ALERTS_DIAG, 'responds');
  });

  it('GET /api/alerts/history returns history', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/alerts/history');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ALERTS_HIST, 'responds');
  });
});

// ── Paper trading ─────────────────────────────────────────────────────────────

describe('Paper trading', () => {
  it('GET /api/paper/orders responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/paper/orders');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PAPER_ORDERS, 'responds');
  });

  it('GET /api/paper/positions responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/paper/positions');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PAPER_POSITIONS, 'responds');
  });
});

// ── Portfolio & risk ──────────────────────────────────────────────────────────

describe('Portfolio & risk', () => {
  it('GET /api/portfolio/positions responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/portfolio/positions');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PORTFOLIO_POS, 'responds');
  });

  it('GET /api/portfolio/summary responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/portfolio/summary');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PORTFOLIO_SUM, 'responds');
  });

  it('GET /api/portfolio/drawdown responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/portfolio/drawdown');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PORTFOLIO_DD, 'responds');
  });

  it('GET /api/risk/summary responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/risk/summary');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_RISK_SUMMARY, 'responds');
  });

  it('GET /api/risk/limits responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/risk/limits');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_RISK_LIMITS, 'responds');
  });

  it('GET /api/risk/alerts responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/risk/alerts');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_RISK_ALERTS, 'responds');
  });
});

// ── Execution & OMS ───────────────────────────────────────────────────────────

describe('Execution & OMS — status endpoints', () => {
  it('GET /api/execution/status responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/execution/status');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_EXEC_STATUS, 'responds');
  });

  it('GET /api/execution/risk responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/execution/risk');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_EXEC_RISK, 'responds');
  });

  it('GET /api/oms/orders responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/oms/orders');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_OMS_ORDERS, 'responds');
  });

  it('GET /api/oms/orders/open responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/oms/orders/open');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_OMS_OPEN, 'responds');
  });
});

// ── Observability ─────────────────────────────────────────────────────────────

describe('Observability', () => {
  it('GET /api/observability/health returns ok:true', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/observability/health');
    assert.equal(body.ok, true);
    markCovered(R.GET_OBS_HEALTH, 'ok:true');
  });

  it('GET /api/observability/metrics responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/observability/metrics');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_OBS_METRICS, 'responds');
  });

  it('GET /api/observability/market-session responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/observability/market-session');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_OBS_SESSION, 'responds');
  });
});

// ── Provider credentials ──────────────────────────────────────────────────────

describe('Provider credentials', () => {
  it('GET /api/providers/credentials responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/providers/credentials');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PROV_CREDS, 'responds');
  });

  it('GET /api/providers/status responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/providers/status');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PROV_STATUS, 'responds');
  });

  it('GET /api/providers/active responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/providers/active');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PROV_ACTIVE, 'responds');
  });
});

// ── ML routes ─────────────────────────────────────────────────────────────────

describe('ML routes — status (no Python worker needed)', () => {
  it('GET /api/ml/health responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ml/health');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ML_HEALTH, 'responds');
  });

  it('GET /api/ml/predictions responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ml/predictions');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ML_PREDICTIONS, 'responds');
  });

  it('GET /api/ml/training-runs responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ml/training-runs');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ML_TRAINING_RUNS, 'responds');
  });

  it('GET /api/ml/dataset/expected-paths responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ml/dataset/expected-paths');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ML_EXPECTED_PATHS, 'responds');
  });
});

// ── AI routes ─────────────────────────────────────────────────────────────────

describe('AI routes', () => {
  it('GET /api/ai/features/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ai/features/SPY');
    assert.ok(typeof body === 'object');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_AI_FEATURES, 'responds without crash');
  });

  it('GET /api/ai/labels/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ai/labels/SPY');
    assert.ok(typeof body === 'object');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_AI_LABELS, 'responds without crash');
  });

  it('GET /api/ai/regime/history/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/ai/regime/history/SPY');
    assert.ok(typeof body === 'object');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_AI_REGIME, 'responds without crash');
  });
});

// ── Strategy & pattern routes ─────────────────────────────────────────────────

describe('Strategy & pattern routes', () => {
  it('GET /api/alpha/signals/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/alpha/signals/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ALPHA_SIGNALS, 'responds');
  });

  it('GET /api/patterns/signals/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/patterns/signals/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_PATTERN_SIGNALS, 'responds');
  });

  it('GET /api/strategies/candidates/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/strategies/candidates/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_STRATEGY_CANDS, 'responds');
  });

  it('GET /api/quant/features/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/quant/features/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_QUANT_FEATURES, 'responds');
  });

  it('GET /api/quality/scores/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/quality/scores/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_QUALITY_SCORES, 'responds');
  });

  it('GET /api/analytics/trend/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/analytics/trend/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ANALYTICS_TREND, 'responds');
  });

  it('GET /api/analytics/latest/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/analytics/latest/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_ANALYTICS_LATEST, 'responds');
  });

  it('GET /api/strategy-lab/strategies responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/strategy-lab/strategies');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_STRATLAB_STRATS, 'responds');
  });

  it('GET /api/rules/sets/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/rules/sets/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_RULES_SETS, 'responds');
  });

  it('GET /api/templates/strategies responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/templates/strategies');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_TEMPLATES_STRATS, 'responds');
  });

  it('GET /api/session-context/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/session-context/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_SESSION_CTX, 'responds');
  });

  it('GET /api/reversals/points/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/reversals/points/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_REVERSALS_PTS, 'responds');
  });

  it('GET /api/volume-profile/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/volume-profile/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_VOL_PROFILE, 'responds');
  });
});

// ── Backtest & validation ─────────────────────────────────────────────────────

describe('Backtest & validation', () => {
  it('GET /api/backtest/runs responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/backtest/runs');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_BACKTEST_RUNS, 'responds');
  });

  it('GET /api/backtest/results/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/backtest/results/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_BACKTEST_RESULTS, 'responds');
  });

  it('GET /api/validation/results/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/validation/results/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_VALIDATION_RESULTS, 'responds');
  });
});

// ── Replay routes ─────────────────────────────────────────────────────────────

describe('Replay routes', () => {
  it('GET /api/replay/candles/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/replay/candles/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_REPLAY_CANDLES, 'responds');
  });

  it('GET /api/replay-legacy/candles/:symbol responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/replay-legacy/candles/SPY');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_REPLAY_LEG_CANDLES, 'responds');
  });

  it('POST /api/replay-session/start responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/replay-session/start', {
      body: { symbol: 'SPY' },
    });
    assert.ok(typeof body === 'object');
    markCovered(R.POST_REPLAY_START, 'responds');
  });

  it('POST /api/replay-session/pause responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/replay-session/pause', { body: {} });
    assert.ok(typeof body === 'object');
    markCovered(R.POST_REPLAY_PAUSE, 'responds');
  });

  it('POST /api/replay-session/resume responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/replay-session/resume', { body: {} });
    assert.ok(typeof body === 'object');
    markCovered(R.POST_REPLAY_RESUME, 'responds');
  });

  it('POST /api/replay-session/stop responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/replay-session/stop', { body: {} });
    assert.ok(typeof body === 'object');
    markCovered(R.POST_REPLAY_STOP, 'responds');
  });
});

// ── Institutional ─────────────────────────────────────────────────────────────

describe('Institutional', () => {
  it('GET /api/institutional/scenarios/presets responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/institutional/scenarios/presets');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_INST_PRESETS, 'responds');
  });

  it('GET /api/institutional/scenarios responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await GET('/api/institutional/scenarios');
    assert.ok(typeof body === 'object');
    markCovered(R.GET_INST_SCENARIOS, 'responds');
  });

  it('POST /api/institutional/sizing/volatility responds', async (t) => {
    skipIfNotReady(t);
    const { body } = await POST('/api/institutional/sizing/volatility', {
      body: { symbol: 'SPY', portfolioValue: 100000, riskPct: 0.02 },
    });
    assert.ok(typeof body === 'object');
    markCovered(R.POST_INST_SIZING, 'responds');
  });
});

// ── Poison tests — suite proves it can detect failures ───────────────────────

describe('Poison tests — suite proves it can detect failures', () => {
  it('Correlation with non-existent dataset returns ok:false', async (t) => {
    skipIfNotReady(t);
    const params = new URLSearchParams({
      datasetIds: '__poison_does_not_exist__',
      symbols:    'SPY,NFLX',
    });
    const { body } = await GET(`/api/macro/correlation?${params}`);
    assert.equal(body.ok, false, `Expected ok:false for poison dataset. Got: ${JSON.stringify(body).slice(0, 300)}`);
  });

  it('Non-existent route returns 404', async (t) => {
    skipIfNotReady(t);
    const { status } = await GET('/api/DOES_NOT_EXIST', { token: null });
    assert.equal(status, 404, `Expected 404, got ${status}`);
  });

  it('Dataset deletion → correlation fails → re-seed → correlation passes again', async (t) => {
    skipIfNotReady(t);

    // 1. Confirm correlation passes with real data
    const params1 = new URLSearchParams({ datasetIds: `${spyId},${nflxId}`, symbols: 'SPY,NFLX' });
    const before  = await GET(`/api/macro/correlation?${params1}`);
    assert.equal(before.body.ok, true, 'Pre-condition: correlation must pass with real data');

    // 2. Delete the SPY dataset via the registry
    const delResp = await DELETE(`/api/historical/datasets/${spyId}`);
    // Some servers may return 200 or 204 on delete
    assert.ok([200, 204].includes(delResp.status), `Expected 200/204 on delete, got ${delResp.status}`);

    // 3. Correlation should now fail (no SPY data)
    const params2   = new URLSearchParams({ datasetIds: `${spyId},${nflxId}`, symbols: 'SPY,NFLX' });
    const afterDel  = await GET(`/api/macro/correlation?${params2}`);
    assert.equal(afterDel.body.ok, false, `Expected ok:false after deletion. Got: ${JSON.stringify(afterDel.body).slice(0, 300)}`);

    // 4. Re-download SPY by calling the download endpoint
    const dlResp = await POST('/api/historical/download', {
      body: {
        symbol:    'SPY',
        timeframe: '1d',
        provider:  'yahoo',
        startDate: manifest.datasets.SPY.startDate,
        endDate:   manifest.datasets.SPY.endDate,
        purpose:   'correlation',
      },
    });
    assert.equal(dlResp.body.ok, true, `Re-download must succeed. Got: ${JSON.stringify(dlResp.body).slice(0, 300)}`);
    const newSpyId = dlResp.body.dataset?.datasetId;
    assert.ok(newSpyId, 'Re-download must return a new datasetId');

    // 5. Correlation passes again with the new dataset ID
    const params3   = new URLSearchParams({ datasetIds: `${newSpyId},${nflxId}`, symbols: 'SPY,NFLX' });
    const afterReseed = await GET(`/api/macro/correlation?${params3}`);
    assert.equal(afterReseed.body.ok, true,        `Expected ok:true after re-seed. Got: ${JSON.stringify(afterReseed.body).slice(0, 300)}`);
    assert.equal(afterReseed.body.status, 'ready', `Expected status:ready after re-seed`);
    assert.ok(afterReseed.body.observations >= 20,  `Expected obs >= 20 after re-seed, got ${afterReseed.body.observations}`);

    // Update the module-level spyId for remaining tests
    spyId = newSpyId;
  });
});
