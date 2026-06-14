/**
 * backend-coverage.test.js — Comprehensive functional test suite for the reversal API.
 *
 * Architecture:
 *   before()  → create temp dir → copy committed fixture CSVs → write datasets.json
 *               → spawnTestServer (throws on failure) → forgeJwt
 *   [describes covering every cataloged route with strong assertions]
 *   after()   → killServer → write BACKEND_COVERAGE.json → unconditional coverage barrier
 *
 * Seed is 100% deterministic: committed fixture CSVs under
 *   server/tests/functional/fixtures/raw/
 *
 * No SKIP mechanism. If setup fails the suite fails.
 *
 * Run:
 *   node --test --test-concurrency=1 server/tests/functional/backend-coverage.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { spawnTestServer, killServer, forgeJwt } from './helpers.js';

// ── Paths ──────────────────────────────────────────────────────────────────────

const __filename    = fileURLToPath(import.meta.url);
const __dir         = dirname(__filename);
const REPO_ROOT     = resolve(__dir, '../../../');
const FIXTURES_RAW  = join(__dir, 'fixtures', 'raw');

// ── Fixed dataset IDs (deterministic) ────────────────────────────────────────

const SPY_ID      = 'fixture-spy-1d';
const NFLX_ID     = 'fixture-nflx-1d';
const COMBINED_ID = 'fixture-spy-nflx-combined-1d';

// ── Route coverage map ────────────────────────────────────────────────────────

const COVERAGE = {};

function catalogRoute(method, path) {
  const key = `${method} ${path}`;
  COVERAGE[key] = { status: 'pending', detail: null };
  return key;
}

function markCovered(key, detail = '') {
  COVERAGE[key] = { status: `covered: ${detail}`, detail };
}

function markDeferred(key, reason = '') {
  COVERAGE[key] = { status: `deferred: ${reason}`, detail: reason };
}

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

let serverCtx = null;
let jwt       = null;
let tempDir   = null;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function req(method, path, { body, token, expectStatus } = {}) {
  const url     = `${serverCtx.baseUrl}${path}`;
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
    assert.equal(
      res.status, expectStatus,
      `Expected HTTP ${expectStatus} for ${method} ${path}, got ${res.status}. Body: ${text.slice(0, 200)}`,
    );
  }
  return { status: res.status, body: parsed };
}

function GET(path, opts)    { return req('GET',    path, opts); }
function POST(path, opts)   { return req('POST',   path, opts); }
function DELETE(path, opts) { return req('DELETE', path, opts); }

// ── Guard against NaN / Infinity ──────────────────────────────────────────────

function hasNonFinite(value, path = '') {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return true;
  if (Array.isArray(value)) {
    for (let i = 0; i < Math.min(value.length, 20); i++) {
      if (hasNonFinite(value[i], `${path}[${i}]`)) return true;
    }
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (hasNonFinite(v, `${path}.${k}`)) return true;
    }
  }
  return false;
}

// ── before / after ────────────────────────────────────────────────────────────

before(async () => {
  // 1. Create isolated temp directory for this test run
  tempDir = join(REPO_ROOT, 'tmp', `functional-test-${process.pid}-${Date.now()}`);
  mkdirSync(join(tempDir, 'raw'), { recursive: true });

  // 2. Copy committed fixture CSVs into temp dir
  const SPY_CSV      = join(tempDir, 'raw', 'hist_SPY_1d_fixture.csv');
  const NFLX_CSV     = join(tempDir, 'raw', 'hist_NFLX_1d_fixture.csv');
  const COMBINED_CSV = join(tempDir, 'raw', 'hist_SPY_NFLX_combined_1d_fixture.csv');

  copyFileSync(join(FIXTURES_RAW, 'hist_SPY_1d_fixture.csv'),             SPY_CSV);
  copyFileSync(join(FIXTURES_RAW, 'hist_NFLX_1d_fixture.csv'),            NFLX_CSV);
  copyFileSync(join(FIXTURES_RAW, 'hist_SPY_NFLX_combined_1d_fixture.csv'), COMBINED_CSV);

  // 3. Write datasets.json with fixed IDs pointing to the temp-dir paths.
  //    The registry reads this file directly on startup via HISTORICAL_DATA_DIR.
  function buildEntry(datasetId, symbol, symbols, filePath, rowCount) {
    return {
      datasetId, id: datasetId,
      symbol, symbols,
      timeframe: '1d', provider: 'yahoo',
      startDate: '2025-05-01', endDate: '2025-08-04',
      session: 'RTH', purpose: 'general',
      rowCount,
      rowsBySymbol: Object.fromEntries(symbols.map((s) => [s, rowCount])),
      files: { csv: filePath, parquet: null, json: null },
      filePath,
      schema: 'HistoricalCandle.v1',
      dataHash: '', status: 'ready',
      createdAt: '2025-01-01T00:00:00.000Z',
      warnings: [],
    };
  }

  const registry = {
    version: 1,
    datasets: [
      buildEntry(SPY_ID,      'SPY',  ['SPY'],         SPY_CSV,      65),
      buildEntry(NFLX_ID,     'NFLX', ['NFLX'],        NFLX_CSV,     65),
      buildEntry(COMBINED_ID, 'SPY',  ['SPY', 'NFLX'], COMBINED_CSV, 130),
    ],
  };
  writeFileSync(join(tempDir, 'datasets.json'), JSON.stringify(registry, null, 2));

  // 4. Spawn the real server.js with HISTORICAL_DATA_DIR pointing to tempDir.
  //    spawnTestServer throws if the server does not become healthy — no silent skip.
  serverCtx = await spawnTestServer({
    seedDir:   tempDir,
    jwtSecret: 'functional-test-secret-change-in-ci',
  });

  jwt = forgeJwt(serverCtx.jwtSecret);
  console.log(`[functional] Server at ${serverCtx.baseUrl}  tempDir=${tempDir}`);
});

after(async () => {
  if (serverCtx?.child) await killServer(serverCtx.child);

  // Clean up temp dir
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Write BACKEND_COVERAGE.json — always
  const covPath = join(REPO_ROOT, 'BACKEND_COVERAGE.json');
  try {
    writeFileSync(covPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      routes: COVERAGE,
    }, null, 2));
    console.log(`[functional] Coverage written to ${covPath}`);
  } catch (err) {
    console.warn('[functional] Could not write BACKEND_COVERAGE.json:', err.message);
  }

  // Coverage barrier — UNCONDITIONAL.
  // Every route must be covered or explicitly deferred.
  const uncovered = Object.entries(COVERAGE).filter(
    ([, v]) => !v.status.startsWith('covered') && !v.status.startsWith('deferred:'),
  );
  if (uncovered.length > 0) {
    console.error('[functional] COVERAGE BARRIER FAILED — uncovered routes:');
    for (const [key] of uncovered) console.error(`  ${key}`);
  }
  assert.equal(
    uncovered.length, 0,
    `${uncovered.length} route(s) are neither covered nor deferred:\n` +
    uncovered.map(([k]) => `  ${k}`).join('\n'),
  );
});

// ── Health & version ──────────────────────────────────────────────────────────

describe('Health & version', () => {
  it('GET / returns ok service info', async () => {
    const { body } = await GET('/');
    assert.equal(body.status, 'ok', 'Expected status: ok');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in root response');
    markCovered(R.GET_ROOT, 'status:ok');
  });

  it('GET /health returns { ok: true }', async () => {
    const { status, body } = await GET('/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    markCovered(R.GET_HEALTH, 'ok:true');
  });

  it('GET /api/version returns ok with version string', async () => {
    const { body } = await GET('/api/version');
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string', 'version must be a string');
    markCovered(R.GET_API_VERSION, 'ok:true version:string');
  });
});

// ── Auth flow ─────────────────────────────────────────────────────────────────

describe('Auth flow — register → login → /me', () => {
  const testEmail = `func-test-${Date.now()}@reversal.test`;
  const testPass  = 'FuncTestPass123!';

  it('POST /auth/register creates user and returns token', async () => {
    const { status, body } = await POST('/auth/register', {
      body: { email: testEmail, password: testPass },
      token: null,
      expectStatus: 200,
    });
    assert.equal(typeof body.token, 'string', 'Expected token string');
    assert.ok(body.user, 'Expected user object');
    markCovered(R.POST_AUTH_REGISTER, 'returns token+user');
  });

  it('POST /auth/login authenticates and returns token', async () => {
    const { body } = await POST('/auth/login', {
      body: { email: testEmail, password: testPass },
      token: null,
      expectStatus: 200,
    });
    assert.equal(typeof body.token, 'string', 'Expected token string');
    markCovered(R.POST_AUTH_LOGIN, 'returns token');
  });

  it('GET /auth/me returns user with valid JWT', async () => {
    const { body } = await GET('/auth/me', { expectStatus: 200 });
    assert.ok(body.user, 'Expected user in response');
    markCovered(R.GET_AUTH_ME, 'returns user');
  });
});

// ── Runtime & monitoring ──────────────────────────────────────────────────────

describe('Runtime & monitoring', () => {
  it('GET /api/runtime/health returns ok:true', async () => {
    const { body } = await GET('/api/runtime/health');
    assert.equal(body.ok, true);
    markCovered(R.GET_RUNTIME_HEALTH, 'ok:true');
  });

  it('GET /api/runtime/runtime-status returns ok:true', async () => {
    const { body } = await GET('/api/runtime/runtime-status');
    assert.equal(body.ok, true);
    markCovered(R.GET_RUNTIME_STATUS, 'ok:true');
  });

  it('GET /api/monitoring/runtime-status returns ok:true', async () => {
    const { body } = await GET('/api/monitoring/runtime-status');
    assert.equal(body.ok, true);
    markCovered(R.GET_MONITORING_STATUS, 'ok:true');
  });
});

// ── Historical datasets ───────────────────────────────────────────────────────

describe('Historical — dataset enumeration & candle assertions', () => {
  it('GET /api/historical/providers returns provider array', async () => {
    const { body } = await GET('/api/historical/providers');
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.providers), 'providers must be array');
    markCovered(R.GET_HIST_PROVIDERS, 'ok:true providers:Array');
  });

  it('GET /api/historical/datasets returns >= 2 fixture datasets', async () => {
    const { body } = await GET('/api/historical/datasets');
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.datasets), 'datasets must be array');
    assert.ok(
      body.datasets.length >= 2,
      `Expected >= 2 datasets, got ${body.datasets.length}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in datasets response');
    markCovered(R.GET_HIST_DATASETS, `datasets.length=${body.datasets.length} >= 2`);
  });

  it('GET /api/historical/datasets/:id returns single fixture dataset', async () => {
    const { body } = await GET(`/api/historical/datasets/${SPY_ID}`);
    assert.equal(body.ok, true);
    assert.equal(body.dataset.datasetId, SPY_ID, 'datasetId must match');
    markCovered(R.GET_HIST_DATASET_ID, 'single dataset returned by ID');
  });

  it('GET /api/historical/datasets/:id/candles (SPY) returns >= 50 candles', async () => {
    const { body } = await GET(`/api/historical/datasets/${SPY_ID}/candles`);
    assert.equal(body.ok, true, `Expected ok:true, body: ${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(
      Number.isFinite(body.count) && body.count >= 50,
      `Expected >= 50 candles for SPY, got ${body.count}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in candles');
    markCovered(R.GET_HIST_CANDLES, `count=${body.count} >= 50`);
  });

  it('GET /api/historical/status returns ok:true', async () => {
    const { body } = await GET('/api/historical/status');
    assert.equal(body.ok, true);
    markCovered(R.GET_HIST_STATUS, 'ok:true');
  });

  it('POST /api/historical/use-for-correlation accepts SPY fixture dataset', async () => {
    const { body } = await POST('/api/historical/use-for-correlation', {
      body: { datasetId: SPY_ID },
    });
    assert.equal(body.ok, true, `Expected ok:true, body: ${JSON.stringify(body).slice(0, 300)}`);
    markCovered(R.POST_HIST_USE_CORR, 'ok:true for fixture dataset');
  });
});

// ── Macro — STRONG assertions with seeded fixture data ────────────────────────

describe('Macro — STRONG: correlation, beta, volatility with fixture data', () => {
  it('GET /api/macro/correlation with SPY+NFLX: observations >= 20', async () => {
    const params = new URLSearchParams({
      datasetIds: `${SPY_ID},${NFLX_ID}`,
      symbols:    'SPY,NFLX',
    });
    const { body } = await GET(`/api/macro/correlation?${params}`);
    assert.equal(body.ok, true,        `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.status, 'ready', `Expected status:ready. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.ok(
      Number.isFinite(body.observations) && body.observations >= 20,
      `Expected observations >= 20, got ${body.observations}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in macro/correlation response');
    markCovered(R.GET_MACRO_CORR, `observations=${body.observations}`);
  });

  it('GET /api/macro/beta with NFLX/SPY: finite beta, r2, observations >= 20', async () => {
    const params = new URLSearchParams({
      datasetIds: `${SPY_ID},${NFLX_ID}`,
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
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in macro/beta response');
    markCovered(R.GET_MACRO_BETA, `beta=${body.beta?.toFixed(3)} r2=${body.r2?.toFixed(3)} obs=${body.observations}`);
  });

  it('GET /api/macro/volatility-heatmap for SPY: realizedVol > 0', async () => {
    const params = new URLSearchParams({
      datasetId: SPY_ID,
      symbols:   'SPY',
    });
    const { body } = await GET(`/api/macro/volatility-heatmap?${params}`);
    assert.equal(body.ok, true,        `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.status, 'ready', `Expected status:ready. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.ok(Array.isArray(body.items) && body.items.length > 0, 'Expected non-empty items array');
    const firstItem = body.items[0];
    assert.ok(
      Number.isFinite(firstItem.realizedVol) && firstItem.realizedVol > 0,
      `Expected realizedVol > 0, got ${firstItem.realizedVol}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity in volatility-heatmap');
    markCovered(R.GET_MACRO_VOLHEAT, `realizedVol=${firstItem.realizedVol?.toFixed(4)}`);
  });

  it('GET /api/macro/sector-rotation: ok:true, status not_available, sectors is Array', async () => {
    const params = new URLSearchParams({
      datasetIds: `${SPY_ID},${NFLX_ID}`,
      symbols:    'SPY,NFLX',
    });
    const { body } = await GET(`/api/macro/sector-rotation?${params}`);
    assert.equal(body.ok, true,                   'Expected ok:true');
    assert.equal(body.status, 'not_available',    'Expected status:not_available (metadata missing)');
    assert.ok(Array.isArray(body.sectors),        'sectors must be an Array');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_MACRO_SECTOR, 'ok:true status:not_available sectors:Array');
  });
});

// ── Multi-asset — STRONG assertions (observations >= 20) ─────────────────────

describe('Multi-asset — STRONG: correlation uses combined fixture dataset', () => {
  it('GET /api/multi-asset/correlation with combined SPY+NFLX dataset: observations >= 20', async () => {
    // COMBINED_ID is a single CSV with both SPY and NFLX rows.
    // The original bug returned observations:0; this test proves the fix holds.
    const params = new URLSearchParams({
      datasetId: COMBINED_ID,
      symbols:   'SPY,NFLX',
    });
    const { body } = await GET(`/api/multi-asset/correlation?${params}`);
    assert.equal(body.ok, true,   `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.equal(body.status, 'ok', `Expected status:'ok', not '${body.status}'. Body: ${JSON.stringify(body).slice(0, 400)}`);
    assert.ok(
      Number.isFinite(body.observations) && body.observations >= 20,
      `Expected observations >= 20, got ${body.observations}. The original bug returns 0 here.`,
    );
    assert.ok(Array.isArray(body.matrix), 'matrix must be Array');
    assert.ok(body.matrix.length >= 2,    'matrix must have >= 2 rows');
    assert.ok(!hasNonFinite(body),        'No NaN/Infinity in multi-asset/correlation response');
    markCovered(R.GET_MULTI_CORR, `observations=${body.observations} status:ok matrix[${body.matrix.length}]`);
  });

  it('GET /api/multi-asset/beta — deferred: no datasetId support, requires live subscriptions', () => {
    // The /api/multi-asset/beta route uses multiAssetEngine.betaMetrics() which
    // reads from live market subscriptions, not historical datasets. No strong
    // assertion is possible without live feed in CI.
    markDeferred(R.GET_MULTI_BETA, 'multi_asset_beta_requires_live_market_subscriptions');
  });
});

// ── Market stream & feeds ─────────────────────────────────────────────────────

describe('Market stream & feeds', () => {
  it('GET /api/providers/health returns ok:true + providers array', async () => {
    const { body } = await GET('/api/providers/health');
    assert.equal(body.ok, true,                   'Expected ok:true');
    assert.equal(body.success, true,              'Expected success:true');
    assert.ok(Array.isArray(body.providers),       'providers must be Array');
    markCovered(R.GET_PROVIDERS_HEALTH, 'ok:true success:true providers:Array');
  });

  it('GET /api/market/runtime returns success:true', async () => {
    const { body } = await GET('/api/market/runtime');
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.GET_MARKET_RUNTIME, 'success:true');
  });

  it('GET /api/market/subscriptions returns success:true + subscriptions object', async () => {
    const { body } = await GET('/api/market/subscriptions');
    assert.equal(body.success, true,               'Expected success:true');
    assert.equal(typeof body.subscriptions, 'object', 'subscriptions must be object');
    assert.equal(typeof body.count, 'number',      'count must be number');
    markCovered(R.GET_MARKET_SUBS, 'success:true subscriptions:object count:number');
  });

  it('POST /api/market/subscribe returns success:true', async () => {
    const { body } = await POST('/api/market/subscribe', { body: { symbol: 'SPY' } });
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.POST_MARKET_SUB, 'success:true');
  });

  it('DELETE /api/market/subscribe/:symbol responds 200/404/204', async () => {
    const { status } = await DELETE('/api/market/subscribe/SPY');
    assert.ok([200, 204, 404].includes(status), `Unexpected status: ${status}`);
    markCovered(R.DEL_MARKET_SUB, 'status 200|204|404');
  });

  it('GET /api/feeds/status returns ok:true + success:true', async () => {
    const { body } = await GET('/api/feeds/status');
    assert.equal(body.ok,      true, 'Expected ok:true');
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.GET_FEEDS_STATUS, 'ok:true success:true');
  });

  it('GET /api/feeds/providers returns success:true + providers array', async () => {
    const { body } = await GET('/api/feeds/providers');
    assert.equal(body.success, true,          'Expected success:true');
    assert.ok(Array.isArray(body.providers),   'providers must be Array');
    markCovered(R.GET_FEEDS_PROVIDERS, 'success:true providers:Array');
  });
});

// ── Chart ─────────────────────────────────────────────────────────────────────

describe('Chart — with historical dataset (datasetId=fixture-spy-1d)', () => {
  it('GET /api/chart/candles/SPY?datasetId= returns source:historical_dataset + >= 50 candles', async () => {
    const { body } = await GET(`/api/chart/candles/SPY?datasetId=${SPY_ID}`);
    assert.equal(body.success, true,               'Expected success:true');
    assert.equal(body.source,  'historical_dataset', 'Expected source:historical_dataset');
    assert.ok(Array.isArray(body.candles),          'candles must be Array');
    assert.ok(
      body.candles.length >= 50,
      `Expected >= 50 candles from fixture, got ${body.candles.length}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_CHART_CANDLES, `source:historical_dataset candles.length=${body.candles.length}`);
  });

  it('GET /api/chart/indicators/SPY?datasetId= returns source:historical_dataset + indicators', async () => {
    const { body } = await GET(`/api/chart/indicators/SPY?datasetId=${SPY_ID}`);
    assert.equal(body.success, true,               'Expected success:true');
    assert.equal(body.source,  'historical_dataset', 'Expected source:historical_dataset');
    assert.ok(Array.isArray(body.indicators),      'indicators must be Array');
    assert.ok(body.indicators.length > 0,          'indicators must be non-empty with fixture data');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_CHART_INDICATORS, `source:historical_dataset indicators.length=${body.indicators?.length}`);
  });

  it('GET /api/chart/payload/SPY?datasetId= returns source:historical_dataset + >= 50 candles', async () => {
    const { body } = await GET(`/api/chart/payload/SPY?datasetId=${SPY_ID}`);
    assert.equal(body.success, true,               'Expected success:true');
    assert.equal(body.source,  'historical_dataset', 'Expected source:historical_dataset');
    assert.ok(Array.isArray(body.candles),          'candles must be Array');
    assert.ok(
      body.candles.length >= 50,
      `Expected >= 50 candles from fixture, got ${body.candles.length}`,
    );
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_CHART_PAYLOAD, `source:historical_dataset candles.length=${body.candles.length}`);
  });
});

// ── Alerts CRUD ───────────────────────────────────────────────────────────────

describe('Alerts CRUD', () => {
  it('GET /api/alerts returns success:true + alerts Array', async () => {
    const { body } = await GET('/api/alerts');
    assert.equal(body.success, true,     'Expected success:true');
    assert.ok(Array.isArray(body.alerts), 'alerts must be Array');
    assert.equal(typeof body.count, 'number', 'count must be number');
    markCovered(R.GET_ALERTS, 'success:true alerts:Array count:number');
  });

  it('POST /api/alerts creates alert with id', async () => {
    const { body } = await POST('/api/alerts', {
      body: { symbol: 'SPY', type: 'price_above', threshold: 999, params: {} },
    });
    assert.equal(body.success, true,                'Expected success:true');
    assert.ok(body.alert,                           'Expected alert object');
    assert.equal(typeof body.alert.id, 'string',    'alert.id must be string');
    markCovered(R.POST_ALERTS, `success:true alert.id=${body.alert?.id}`);
  });

  it('GET /api/alerts/diagnostics returns success:true', async () => {
    const { body } = await GET('/api/alerts/diagnostics');
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.GET_ALERTS_DIAG, 'success:true');
  });

  it('GET /api/alerts/history returns success:true + history Array', async () => {
    const { body } = await GET('/api/alerts/history');
    assert.equal(body.success, true,     'Expected success:true');
    assert.ok(Array.isArray(body.history), 'history must be Array');
    markCovered(R.GET_ALERTS_HIST, 'success:true history:Array');
  });
});

// ── Paper trading ─────────────────────────────────────────────────────────────

describe('Paper trading', () => {
  it('GET /api/paper/orders returns success:true + orders Array', async () => {
    const { body } = await GET('/api/paper/orders');
    assert.equal(body.success, true,     'Expected success:true');
    assert.ok(Array.isArray(body.orders), 'orders must be Array');
    markCovered(R.GET_PAPER_ORDERS, 'success:true orders:Array');
  });

  it('GET /api/paper/positions returns success:true + positions Array', async () => {
    const { body } = await GET('/api/paper/positions');
    assert.equal(body.success, true,        'Expected success:true');
    assert.ok(Array.isArray(body.positions), 'positions must be Array');
    markCovered(R.GET_PAPER_POSITIONS, 'success:true positions:Array');
  });
});

// ── Portfolio ─────────────────────────────────────────────────────────────────

describe('Portfolio', () => {
  it('GET /api/portfolio/positions returns ok:true + positions Array', async () => {
    const { body } = await GET('/api/portfolio/positions');
    assert.equal(body.ok,      true, 'Expected ok:true');
    assert.equal(body.success, true, 'Expected success:true');
    assert.ok(Array.isArray(body.positions), 'positions must be Array');
    markCovered(R.GET_PORTFOLIO_POS, 'ok:true success:true positions:Array');
  });

  it('GET /api/portfolio/summary returns ok:true + numeric totalPnL', async () => {
    const { body } = await GET('/api/portfolio/summary');
    assert.equal(body.ok,      true, 'Expected ok:true');
    assert.equal(body.success, true, 'Expected success:true');
    assert.equal(typeof body.totalPnL, 'number', 'totalPnL must be number');
    markCovered(R.GET_PORTFOLIO_SUM, 'ok:true success:true totalPnL:number');
  });

  it('GET /api/portfolio/drawdown returns ok:true + drawdown.series Array', async () => {
    const { body } = await GET('/api/portfolio/drawdown');
    assert.equal(body.ok,      true, 'Expected ok:true');
    assert.equal(body.success, true, 'Expected success:true');
    assert.ok(body.drawdown,          'Expected drawdown sub-object');
    assert.ok(Array.isArray(body.drawdown.series), 'drawdown.series must be Array');
    markCovered(R.GET_PORTFOLIO_DD, 'ok:true success:true drawdown.series:Array');
  });
});

// ── Risk ──────────────────────────────────────────────────────────────────────

describe('Risk', () => {
  it('GET /api/risk/summary returns ok:true + risk object', async () => {
    const { body } = await GET('/api/risk/summary');
    assert.equal(body.ok, true,             'Expected ok:true');
    assert.equal(typeof body.risk, 'object', 'risk must be object');
    markCovered(R.GET_RISK_SUMMARY, 'ok:true risk:object');
  });

  it('GET /api/risk/limits returns ok:true + limits object', async () => {
    const { body } = await GET('/api/risk/limits');
    assert.equal(body.ok, true,               'Expected ok:true');
    assert.equal(typeof body.limits, 'object', 'limits must be object');
    markCovered(R.GET_RISK_LIMITS, 'ok:true limits:object');
  });

  it('GET /api/risk/alerts returns ok:true + alerts Array', async () => {
    const { body } = await GET('/api/risk/alerts');
    assert.equal(body.ok, true,       'Expected ok:true');
    assert.ok(Array.isArray(body.alerts), 'alerts must be Array');
    markCovered(R.GET_RISK_ALERTS, 'ok:true alerts:Array');
  });
});

// ── Execution & OMS ───────────────────────────────────────────────────────────

describe('Execution & OMS', () => {
  it('GET /api/execution/status returns ok:true', async () => {
    const { body } = await GET('/api/execution/status');
    assert.equal(body.ok, true, 'Expected ok:true');
    markCovered(R.GET_EXEC_STATUS, 'ok:true');
  });

  it('GET /api/execution/risk returns ok:true', async () => {
    const { body } = await GET('/api/execution/risk');
    assert.equal(body.ok, true, 'Expected ok:true');
    markCovered(R.GET_EXEC_RISK, 'ok:true');
  });

  it('GET /api/oms/orders returns ok:true + orders Array + count number', async () => {
    const { body } = await GET('/api/oms/orders');
    assert.equal(body.ok, true,          'Expected ok:true');
    assert.ok(Array.isArray(body.orders), 'orders must be Array');
    assert.equal(typeof body.count, 'number', 'count must be number');
    markCovered(R.GET_OMS_ORDERS, 'ok:true orders:Array count:number');
  });

  it('GET /api/oms/orders/open returns ok:true + orders Array', async () => {
    const { body } = await GET('/api/oms/orders/open');
    assert.equal(body.ok, true,          'Expected ok:true');
    assert.ok(Array.isArray(body.orders), 'orders must be Array');
    markCovered(R.GET_OMS_OPEN, 'ok:true orders:Array');
  });
});

// ── Observability ─────────────────────────────────────────────────────────────

describe('Observability', () => {
  it('GET /api/observability/health returns ok:true', async () => {
    const { body } = await GET('/api/observability/health');
    assert.equal(body.ok, true);
    markCovered(R.GET_OBS_HEALTH, 'ok:true');
  });

  it('GET /api/observability/metrics returns ok:true', async () => {
    const { body } = await GET('/api/observability/metrics');
    assert.equal(body.ok, true);
    markCovered(R.GET_OBS_METRICS, 'ok:true');
  });

  it('GET /api/observability/market-session returns ok:true', async () => {
    const { body } = await GET('/api/observability/market-session');
    assert.equal(body.ok, true);
    markCovered(R.GET_OBS_SESSION, 'ok:true');
  });
});

// ── Provider credentials ──────────────────────────────────────────────────────

describe('Provider credentials', () => {
  it('GET /api/providers/credentials returns ok:true + success:true', async () => {
    const { body } = await GET('/api/providers/credentials');
    assert.equal(body.ok,      true, 'Expected ok:true');
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.GET_PROV_CREDS, 'ok:true success:true');
  });

  it('GET /api/providers/status returns ok:true + providers Array', async () => {
    const { body } = await GET('/api/providers/status');
    assert.equal(body.ok,      true,            'Expected ok:true');
    assert.equal(body.success, true,            'Expected success:true');
    assert.ok(Array.isArray(body.providers),     'providers must be Array');
    markCovered(R.GET_PROV_STATUS, 'ok:true success:true providers:Array');
  });

  it('GET /api/providers/active returns ok:true + success:true', async () => {
    const { body } = await GET('/api/providers/active');
    assert.equal(body.ok,      true, 'Expected ok:true');
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.GET_PROV_ACTIVE, 'ok:true success:true');
  });
});

// ── ML routes (Node.js status endpoints — no Python worker required) ──────────

describe('ML routes — status endpoints (no Python worker needed)', () => {
  it('GET /api/ml/health returns ok:true + worker object', async () => {
    const { body } = await GET('/api/ml/health');
    assert.equal(body.ok,          true,     'Expected ok:true');
    assert.equal(body.status, 'available',   'Expected status:available');
    assert.equal(typeof body.worker, 'object', 'worker must be object');
    markCovered(R.GET_ML_HEALTH, 'ok:true status:available worker:object');
  });

  it('GET /api/ml/predictions returns ok:true + predictions Array', async () => {
    const { body } = await GET('/api/ml/predictions');
    assert.equal(body.ok, true,              'Expected ok:true');
    assert.ok(Array.isArray(body.predictions), 'predictions must be Array');
    assert.equal(typeof body.count, 'number',  'count must be number');
    markCovered(R.GET_ML_PREDICTIONS, 'ok:true predictions:Array count:number');
  });

  it('GET /api/ml/training-runs returns ok:true + runs Array', async () => {
    const { body } = await GET('/api/ml/training-runs');
    assert.equal(body.ok, true,        'Expected ok:true');
    assert.ok(Array.isArray(body.runs), 'runs must be Array');
    markCovered(R.GET_ML_TRAINING_RUNS, 'ok:true runs:Array');
  });

  it('GET /api/ml/dataset/expected-paths returns ok:true + expectedPaths', async () => {
    const { body } = await GET('/api/ml/dataset/expected-paths');
    assert.equal(body.ok, true,                    'Expected ok:true');
    assert.ok(body.expectedPaths,                   'expectedPaths must be present');
    markCovered(R.GET_ML_EXPECTED_PATHS, 'ok:true expectedPaths present');
  });
});

// ── AI routes (Node.js engines, no Python) ────────────────────────────────────

describe('AI routes', () => {
  it('GET /api/ai/features/:symbol returns ok:true + symbol + records Array', async () => {
    const { body } = await GET('/api/ai/features/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.records), 'records must be Array');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_AI_FEATURES, 'ok:true symbol:SPY records:Array');
  });

  it('GET /api/ai/labels/:symbol returns ok:true + symbol + labels Array', async () => {
    const { body } = await GET('/api/ai/labels/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.labels), 'labels must be Array');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_AI_LABELS, 'ok:true symbol:SPY labels:Array');
  });

  it('GET /api/ai/regime/history/:symbol returns ok:true + symbol + history Array', async () => {
    const { body } = await GET('/api/ai/regime/history/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.history), 'history must be Array');
    assert.ok(!hasNonFinite(body), 'No NaN/Infinity');
    markCovered(R.GET_AI_REGIME, 'ok:true symbol:SPY history:Array');
  });
});

// ── Strategy & pattern routes ─────────────────────────────────────────────────

describe('Strategy & pattern routes', () => {
  it('GET /api/alpha/signals/:symbol returns ok:true + symbol + signals Array', async () => {
    const { body } = await GET('/api/alpha/signals/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.signals), 'signals must be Array');
    markCovered(R.GET_ALPHA_SIGNALS, 'ok:true symbol:SPY signals:Array');
  });

  it('GET /api/patterns/signals/:symbol returns ok:true + symbol + patterns Array', async () => {
    const { body } = await GET('/api/patterns/signals/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.patterns), 'patterns must be Array');
    markCovered(R.GET_PATTERN_SIGNALS, 'ok:true symbol:SPY patterns:Array');
  });

  it('GET /api/strategies/candidates/:symbol returns ok:true + symbol + strategies Array', async () => {
    const { body } = await GET('/api/strategies/candidates/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.strategies), 'strategies must be Array');
    markCovered(R.GET_STRATEGY_CANDS, 'ok:true symbol:SPY strategies:Array');
  });

  it('GET /api/quant/features/:symbol returns ok:true + symbol + features object', async () => {
    const { body } = await GET('/api/quant/features/SPY');
    assert.equal(body.ok,     true,     'Expected ok:true');
    assert.equal(body.symbol, 'SPY',    'Expected symbol:SPY');
    assert.equal(typeof body.features, 'object', 'features must be object');
    markCovered(R.GET_QUANT_FEATURES, 'ok:true symbol:SPY features:object');
  });

  it('GET /api/quality/scores/:symbol returns ok:true + symbol + qualityScores Array', async () => {
    const { body } = await GET('/api/quality/scores/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.qualityScores), 'qualityScores must be Array');
    markCovered(R.GET_QUALITY_SCORES, 'ok:true symbol:SPY qualityScores:Array');
  });

  it('GET /api/analytics/trend/:symbol returns ok:true + symbol', async () => {
    const { body } = await GET('/api/analytics/trend/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    markCovered(R.GET_ANALYTICS_TREND, 'ok:true symbol:SPY');
  });

  it('GET /api/analytics/latest/:symbol returns ok:true + symbol', async () => {
    const { body } = await GET('/api/analytics/latest/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    markCovered(R.GET_ANALYTICS_LATEST, 'ok:true symbol:SPY');
  });

  it('GET /api/strategy-lab/strategies returns ok:true + strategies Array', async () => {
    const { body } = await GET('/api/strategy-lab/strategies');
    assert.equal(body.ok, true,             'Expected ok:true');
    assert.ok(Array.isArray(body.strategies), 'strategies must be Array');
    markCovered(R.GET_STRATLAB_STRATS, 'ok:true strategies:Array');
  });

  it('GET /api/rules/sets/:symbol returns ok:true + symbol + ruleSets Array', async () => {
    const { body } = await GET('/api/rules/sets/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.ruleSets), 'ruleSets must be Array');
    markCovered(R.GET_RULES_SETS, 'ok:true symbol:SPY ruleSets:Array');
  });

  it('GET /api/templates/strategies returns ok:true + templates Array', async () => {
    const { body } = await GET('/api/templates/strategies');
    assert.equal(body.ok, true,            'Expected ok:true');
    assert.ok(Array.isArray(body.templates), 'templates must be Array');
    markCovered(R.GET_TEMPLATES_STRATS, 'ok:true templates:Array');
  });

  it('GET /api/session-context/:symbol returns ok:true + symbol', async () => {
    const { body } = await GET('/api/session-context/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    markCovered(R.GET_SESSION_CTX, 'ok:true symbol:SPY');
  });

  it('GET /api/reversals/points/:symbol returns ok:true + symbol + reversalPoints Array', async () => {
    const { body } = await GET('/api/reversals/points/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    assert.ok(Array.isArray(body.reversalPoints), 'reversalPoints must be Array');
    markCovered(R.GET_REVERSALS_PTS, 'ok:true symbol:SPY reversalPoints:Array');
  });

  it('GET /api/volume-profile/:symbol returns success:true', async () => {
    const { body } = await GET('/api/volume-profile/SPY');
    assert.equal(body.success, true, 'Expected success:true');
    markCovered(R.GET_VOL_PROFILE, 'success:true');
  });
});

// ── Backtest & validation ─────────────────────────────────────────────────────

describe('Backtest & validation', () => {
  it('GET /api/backtest/runs returns ok:true + runs Array', async () => {
    const { body } = await GET('/api/backtest/runs');
    assert.equal(body.ok, true,       'Expected ok:true');
    assert.ok(Array.isArray(body.runs), 'runs must be Array');
    markCovered(R.GET_BACKTEST_RUNS, 'ok:true runs:Array');
  });

  it('GET /api/backtest/results/:symbol returns ok:true + symbol', async () => {
    const { body } = await GET('/api/backtest/results/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    markCovered(R.GET_BACKTEST_RESULTS, 'ok:true symbol:SPY');
  });

  it('GET /api/validation/results/:symbol returns ok:true + symbol', async () => {
    const { body } = await GET('/api/validation/results/SPY');
    assert.equal(body.ok,     true,  'Expected ok:true');
    assert.equal(body.symbol, 'SPY', 'Expected symbol:SPY');
    markCovered(R.GET_VALIDATION_RESULTS, 'ok:true symbol:SPY');
  });
});

// ── Replay routes ─────────────────────────────────────────────────────────────

describe('Replay routes', () => {
  it('GET /api/replay/candles/:symbol returns success:true + candles Array', async () => {
    const { body } = await GET('/api/replay/candles/SPY');
    assert.equal(body.success, true,      'Expected success:true');
    assert.ok(Array.isArray(body.candles), 'candles must be Array');
    markCovered(R.GET_REPLAY_CANDLES, 'success:true candles:Array');
  });

  it('GET /api/replay-legacy/candles/:symbol returns success:true + candles Array', async () => {
    const { body } = await GET('/api/replay-legacy/candles/SPY');
    assert.equal(body.success, true,      'Expected success:true');
    assert.ok(Array.isArray(body.candles), 'candles must be Array');
    markCovered(R.GET_REPLAY_LEG_CANDLES, 'success:true candles:Array');
  });

  it('POST /api/replay-session/start returns ok:true + action:start + state', async () => {
    const { body } = await POST('/api/replay-session/start', { body: { symbol: 'SPY' } });
    assert.equal(body.ok,     true,    'Expected ok:true');
    assert.equal(body.action, 'start', 'Expected action:start');
    assert.ok(body.state,              'Expected state object');
    markCovered(R.POST_REPLAY_START, 'ok:true action:start state present');
  });

  it('POST /api/replay-session/pause returns ok:true + action:pause', async () => {
    const { body } = await POST('/api/replay-session/pause', { body: {} });
    assert.equal(body.ok,     true,    'Expected ok:true');
    assert.equal(body.action, 'pause', 'Expected action:pause');
    markCovered(R.POST_REPLAY_PAUSE, 'ok:true action:pause');
  });

  it('POST /api/replay-session/resume returns ok:true + action:resume', async () => {
    const { body } = await POST('/api/replay-session/resume', { body: {} });
    assert.equal(body.ok,     true,     'Expected ok:true');
    assert.equal(body.action, 'resume', 'Expected action:resume');
    markCovered(R.POST_REPLAY_RESUME, 'ok:true action:resume');
  });

  it('POST /api/replay-session/stop returns ok:true + action:stop', async () => {
    const { body } = await POST('/api/replay-session/stop', { body: {} });
    assert.equal(body.ok,     true,   'Expected ok:true');
    assert.equal(body.action, 'stop', 'Expected action:stop');
    markCovered(R.POST_REPLAY_STOP, 'ok:true action:stop');
  });
});

// ── Institutional ─────────────────────────────────────────────────────────────

describe('Institutional', () => {
  it('GET /api/institutional/scenarios/presets returns ok:true + non-empty presets Array', async () => {
    const { body } = await GET('/api/institutional/scenarios/presets');
    assert.equal(body.ok, true,          'Expected ok:true');
    assert.ok(Array.isArray(body.presets), 'presets must be Array');
    assert.ok(body.presets.length > 0,     'presets must not be empty (static list)');
    markCovered(R.GET_INST_PRESETS, `ok:true presets.length=${body.presets.length}`);
  });

  it('GET /api/institutional/scenarios returns ok:true + scenarios Array', async () => {
    const { body } = await GET('/api/institutional/scenarios');
    assert.equal(body.ok, true,            'Expected ok:true');
    assert.ok(Array.isArray(body.scenarios), 'scenarios must be Array');
    markCovered(R.GET_INST_SCENARIOS, 'ok:true scenarios:Array');
  });

  it('POST /api/institutional/sizing/volatility returns ok:true with correct fields', async () => {
    // Route requires { accountSize, annualizedVol, currentPrice } — NOT symbol/portfolioValue/riskPct
    const { body } = await POST('/api/institutional/sizing/volatility', {
      body: { accountSize: 100000, annualizedVol: 0.20, currentPrice: 500 },
    });
    assert.equal(body.ok, true, `Expected ok:true. Body: ${JSON.stringify(body).slice(0, 300)}`);
    markCovered(R.POST_INST_SIZING, 'ok:true accountSize+annualizedVol+currentPrice');
  });
});

// ── Poison tests — suite proves it can detect failures ───────────────────────

describe('Poison tests — suite proves it bites', () => {
  it('Macro correlation with non-existent dataset ID returns ok:false', async () => {
    const params = new URLSearchParams({
      datasetIds: '__poison_does_not_exist__,__also_fake__',
      symbols:    'SPY,NFLX',
    });
    const { body } = await GET(`/api/macro/correlation?${params}`);
    assert.equal(
      body.ok, false,
      `Expected ok:false for poison dataset. Got: ${JSON.stringify(body).slice(0, 300)}`,
    );
  });

  it('Non-existent route returns 404', async () => {
    const { status } = await GET('/api/DOES_NOT_EXIST', { token: null });
    assert.equal(status, 404, `Expected 404, got ${status}`);
  });

  it('Multi-asset correlation WITHOUT datasetId returns not_enough_data (not ok:true/status:ok)', async () => {
    // Without datasetId the route always returns not_enough_data.
    // If someone removes the assertion guard this test will flip to ok:true and
    // status:'ok' which would reveal the data path is not wired.
    const params = new URLSearchParams({ symbols: 'SPY,NFLX' });
    const { body } = await GET(`/api/multi-asset/correlation?${params}`);
    assert.equal(body.ok, true,                        'ok is always true for multi-asset/correlation');
    assert.equal(body.status, 'not_enough_data',       'Without datasetId, status must be not_enough_data');
    assert.equal(body.observations, 0,                 'Without datasetId, observations must be 0');
    // If the observations assertion above fails, the combined-dataset test above would also fail
    // because a buggy route returning observations:0 is what we test against there.
  });

  it('Institutional sizing with missing required fields returns HTTP 400', async () => {
    // Route requires { accountSize, annualizedVol, currentPrice }.
    // Sending wrong fields must return 400, not 200.
    const { status, body } = await POST('/api/institutional/sizing/volatility', {
      body: { symbol: 'SPY', portfolioValue: 100000, riskPct: 0.02 },
    });
    assert.equal(status, 400, `Expected 400 for missing required fields. Got ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(body.ok, false, 'Expected ok:false when required fields are absent');
  });

  it('Macro correlation with SPY+NFLX fixture: observations >= 20 (pre-condition for poison)', async () => {
    // Proves that the suite is sensitive: if the fixture data vanished this assertion would fail.
    const params = new URLSearchParams({
      datasetIds: `${SPY_ID},${NFLX_ID}`,
      symbols:    'SPY,NFLX',
    });
    const { body } = await GET(`/api/macro/correlation?${params}`);
    assert.equal(body.ok, true,        'ok must be true with fixture data');
    assert.equal(body.status, 'ready', 'status must be ready with fixture data');
    assert.ok(
      body.observations >= 20,
      `observations must be >= 20 with fixture data; got ${body.observations}. ` +
      'If this fails, the fixture data or the correlation logic is broken.',
    );
  });

  it('Chart candles with bad datasetId returns empty candles array (not fallback_demo)', async () => {
    const { body } = await GET('/api/chart/candles/SPY?datasetId=__poison_does_not_exist__');
    assert.equal(body.success, true,              'success is true (graceful degradation)');
    assert.equal(body.source, 'dataset_error',   'source must be dataset_error — not fallback_demo');
    assert.ok(
      Array.isArray(body.candles) && body.candles.length === 0,
      'Bad datasetId must yield 0 candles, not synthetic fallback data',
    );
  });

  it('Chart candles WITH valid fixture datasetId returns historical_dataset source (not fallback_demo)', async () => {
    // Proves that the datasetId path is actually wired: if getCandles() ignores datasetId
    // the source would be fallback_demo and this assertion fails.
    const { body } = await GET(`/api/chart/candles/SPY?datasetId=${SPY_ID}`);
    assert.equal(body.success, true,                'success:true');
    assert.equal(body.source, 'historical_dataset', 'Must use historical_dataset, not fallback_demo');
    assert.ok(
      body.candles.length >= 50,
      `Must return >= 50 real candles from fixture; got ${body.candles.length}`,
    );
  });
});
