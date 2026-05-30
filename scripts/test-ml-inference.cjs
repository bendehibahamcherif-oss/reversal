/**
 * Integration tests — ML Inference Wrapper
 * ─────────────────────────────────────────
 * Tests the /api/ml/* endpoints without requiring a trained champion model.
 * All covered cases are deterministic against schema validation and
 * registry lookup behaviour.
 *
 * Run:   node scripts/test-ml-inference.cjs
 * Port:  SMOKE_PORT env var (default 19092)
 */

'use strict';

const { spawn } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT || 19092);
const BASE = `http://127.0.0.1:${PORT}`;

// ── helpers ────────────────────────────────────────────────────────────────

async function waitReady(timeoutMs = 14_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/runtime/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start on ${BASE} within ${timeoutMs}ms`);
}

async function request(method, path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return {
    status:  r.status,
    body:    await r.json().catch(() => null),
    headers: r.headers,
  };
}

const get  = (path, h)        => request('GET',  path, null, h);
const post = (path, body, h)  => request('POST', path, body, h);

let _passed = 0;
let _failed = 0;

function ok(label) {
  _passed++;
  console.log(`  ✓  ${label}`);
}

function fail(label, reason) {
  _failed++;
  console.error(`  ✗  ${label}\n     ${reason}`);
}

function assert(cond, label, reason) {
  if (cond) ok(label);
  else       fail(label, reason || 'assertion failed');
}

// ── test suites ────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\n── Health endpoint ──────────────────────────────────────────');
  const { status, body, headers } = await get('/api/ml/health');

  assert(status === 200,                       'GET /api/ml/health → 200',          `got ${status}`);
  assert(body?.ok === true,                    'body.ok is true',                   JSON.stringify(body));
  assert(body?.service === 'ml-inference-worker', 'body.service correct',           body?.service);
  assert(typeof body?.hardTimeoutMs === 'number', 'hardTimeoutMs is a number',       typeof body?.hardTimeoutMs);
  assert(body?.hardTimeoutMs === 400,          'hardTimeoutMs === 400',             `got ${body?.hardTimeoutMs}`);
  assert(typeof body?.champions === 'number',  'champions is a number',             typeof body?.champions);
  assert(Array.isArray(body?.championSymbols), 'championSymbols is an array',       typeof body?.championSymbols);
  assert(body?.pool?.poolType === 'single-process', 'pool.poolType single-process', body?.pool?.poolType);
  assert(typeof body?.pool?.totalRequests === 'number', 'pool.totalRequests present', typeof body?.pool?.totalRequests);
  assert(typeof body?.pool?.hardTimeoutMs === 'number', 'pool.hardTimeoutMs present', typeof body?.pool?.hardTimeoutMs);
  assert(headers.get('x-trace-id') != null,   'X-Trace-Id header present',          'missing');
  assert(headers.get('x-ratelimit-limit') != null, 'X-RateLimit-Limit header present', 'missing');
}

async function testNoChampion() {
  console.log('\n── No champion model (422) ──────────────────────────────────');
  const { status, body } = await post('/api/ml/infer/NOSYMBOL_SMOKE_999', {
    features: { rsi_14: 0.5, ema_delta: 0.001, volume_ratio: 1.2 },
  });

  assert(status === 422,                  'POST /api/ml/infer/NOSYMBOL → 422',    `got ${status}`);
  assert(body?.ok === false,              'body.ok is false',                     JSON.stringify(body));
  assert(body?.code === 'NO_CHAMPION',    'code is NO_CHAMPION',                  body?.code);
  assert(typeof body?.error === 'string', 'error message is a string',            typeof body?.error);
  assert(body?.details?.symbol != null,   'details.symbol present',               JSON.stringify(body?.details));
}

async function testSchemaValidation() {
  console.log('\n── Input schema validation (400) ────────────────────────────');

  // Missing features
  {
    const { status, body } = await post('/api/ml/infer/SPY', {});
    assert(status === 400,                   'missing features → 400',            `got ${status}`);
    assert(body?.code === 'INVALID_INPUT',   'code INVALID_INPUT',                body?.code);
    assert(Array.isArray(body?.errors) && body.errors.length > 0,
                                             'errors array non-empty',            JSON.stringify(body?.errors));
  }

  // features is an array (wrong type)
  {
    const { status, body } = await post('/api/ml/infer/SPY', { features: [0.5, 0.3] });
    assert(status === 400,                   'array features → 400',              `got ${status}`);
    assert(body?.code === 'INVALID_INPUT',   'code INVALID_INPUT',                body?.code);
  }

  // Empty features object
  {
    const { status, body } = await post('/api/ml/infer/SPY', { features: {} });
    assert(status === 400,                   'empty features → 400',              `got ${status}`);
    assert(body?.code === 'INVALID_INPUT',   'code INVALID_INPUT',                body?.code);
  }

  // Non-numeric feature value
  {
    const { status, body } = await post('/api/ml/infer/SPY', {
      features: { rsi_14: 'not-a-number' },
    });
    assert(status === 400,                   'string feature value → 400',        `got ${status}`);
    assert(body?.code === 'INVALID_INPUT',   'code INVALID_INPUT',                body?.code);
    const hasFieldError = Array.isArray(body?.errors) &&
      body.errors.some((e) => String(e).includes('rsi_14'));
    assert(hasFieldError,                    'error identifies offending field',   JSON.stringify(body?.errors));
  }

  // Infinity feature value
  {
    const { status, body } = await post('/api/ml/infer/SPY', {
      features: { rsi_14: Infinity },
    });
    assert(status === 400,                   'Infinity feature → 400',            `got ${status}`);
  }

  // Wrong timeframe type
  {
    const { status, body } = await post('/api/ml/infer/SPY', {
      features: { rsi_14: 0.5 },
      timeframe: 123,
    });
    assert(status === 400,                   'numeric timeframe → 400',           `got ${status}`);
    assert(body?.code === 'INVALID_INPUT',   'code INVALID_INPUT',                body?.code);
  }

  // Wrong modelId type
  {
    const { status, body } = await post('/api/ml/infer/SPY', {
      features: { rsi_14: 0.5 },
      modelId: { nested: true },
    });
    assert(status === 400,                   'object modelId → 400',              `got ${status}`);
    assert(body?.code === 'INVALID_INPUT',   'code INVALID_INPUT',                body?.code);
  }

  // Null body
  {
    const r = await fetch(`${BASE}/api/ml/infer/SPY`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert(r.status === 400,                 'null body → 400',                   `got ${r.status}`);
  }
}

async function testTraceIdPropagation() {
  console.log('\n── Trace-ID propagation ──────────────────────────────────────');

  const customTrace = 'smoke-ml-trace-00042';
  const { status, headers } = await post(
    '/api/ml/infer/SMOKE_TRACE_CHECK',
    { features: { rsi: 0.5 } },
    { 'X-Trace-Id': customTrace },
  );
  // 422 expected (no champion), but trace must be echoed
  assert(status === 422,                              'expected 422 for no-champion',   `got ${status}`);
  assert(headers.get('x-trace-id') === customTrace,  'X-Trace-Id echoed back',         headers.get('x-trace-id'));
}

async function testPoolStatsUpdated() {
  console.log('\n── Pool stats accumulate across requests ─────────────────────');

  const before = (await get('/api/ml/health')).body?.pool?.totalRequests ?? 0;

  // Fire a few validation errors (they still go through the pool counter)
  await post('/api/ml/infer/SPY', {});
  await post('/api/ml/infer/SPY', { features: {} });
  await post('/api/ml/infer/POOLTEST_NOSYM', { features: { x: 1.0 } });

  const after = (await get('/api/ml/health')).body?.pool?.totalRequests ?? 0;

  // schema errors (400) are caught before pool.infer is called, so only
  // the NO_CHAMPION call above increments; check at least 1 new request
  assert(after >= before + 1,
    `pool.totalRequests incremented (${before} → ${after})`,
    `before=${before} after=${after}`);
}

// ── runner ─────────────────────────────────────────────────────────────────

async function run() {
  const server = spawn(process.execPath, ['server/index.cjs'], {
    env: {
      ...process.env,
      PORT:                  String(PORT),
      MONGO_URI:             '',
      RATE_LIMIT_MAX:        '1000',
      RATE_LIMIT_STRICT_MAX: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[srv-err] ${d}`));

  try {
    await waitReady();

    await testHealth();
    await testNoChampion();
    await testSchemaValidation();
    await testTraceIdPropagation();
    await testPoolStatsUpdated();

    console.log(`\n${'─'.repeat(60)}`);
    if (_failed === 0) {
      console.log(`✓  All ${_passed} tests passed.`);
    } else {
      console.error(`✗  ${_failed} test(s) failed (${_passed} passed).`);
      process.exitCode = 1;
    }
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('\nFatal:', err.message);
  process.exitCode = 1;
});
