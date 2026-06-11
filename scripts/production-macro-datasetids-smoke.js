#!/usr/bin/env node
/**
 * Production smoke test for multi-dataset macro correlation and beta endpoints.
 *
 * Usage:
 *   node scripts/production-macro-datasetids-smoke.js
 *   API_BASE=https://reversal.onrender.com node scripts/production-macro-datasetids-smoke.js
 *
 * To test with specific dataset IDs from your registry:
 *   SPY_ID=hist_SPY_1d_RTH_... NFLX_ID=hist_NFLX_1d_RTH_... \
 *     API_BASE=https://reversal.onrender.com \
 *     node scripts/production-macro-datasetids-smoke.js
 */

const API_BASE  = process.env.API_BASE  || 'http://localhost:3000';
const SPY_ID    = process.env.SPY_ID    || null;
const NFLX_ID   = process.env.NFLX_ID  || null;

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

let passed = 0;
let failed = 0;
const results = [];

async function get(path) {
  const url = `${API_BASE}${path}`;
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await resp.text();
  const isHtml = text.trimStart().startsWith('<');
  let body = null;
  if (!isHtml) {
    try { body = JSON.parse(text); } catch { /* not JSON */ }
  }
  return { status: resp.status, isHtml, body, url };
}

function hasNonFinite(obj) {
  return /\bNaN\b|\bInfinity\b/.test(JSON.stringify(obj));
}

function check(label, cond, detail) {
  if (cond) {
    console.log(`  ${PASS} ${label}`);
    passed++;
    results.push({ label, ok: true });
  } else {
    console.log(`  ${FAIL} ${label}${detail ? `: ${detail}` : ''}`);
    failed++;
    results.push({ label, ok: false, detail });
  }
}

function warn(label, detail) {
  console.log(`  ${WARN} ${label}${detail ? `: ${detail}` : ''}`);
  results.push({ label, ok: 'warn', detail });
}

async function runCase(title, path) {
  console.log(`\n[${title}]`);
  console.log(`  → ${API_BASE}${path}`);
  let r;
  try {
    r = await get(path);
  } catch (err) {
    check('request succeeded', false, err.message);
    return null;
  }
  check('status 200', r.status === 200, `got ${r.status}`);
  check('not HTML', !r.isHtml, r.isHtml ? 'response is HTML' : '');
  check('valid JSON', r.body !== null, 'response not parseable as JSON');
  if (!r.body) return null;
  check('no NaN/Infinity', !hasNonFinite(r.body));
  return r.body;
}

async function main() {
  console.log(`\nMacro multi-dataset smoke — ${API_BASE}`);
  console.log('='.repeat(60));

  // ── 1. Baseline: no datasetId → not_enough_data (expected) ───────────────
  {
    const body = await runCase(
      'Correlation — no dataset (baseline)',
      '/api/macro/correlation?symbols=SPY,NFLX&window=5&timeframe=1d'
    );
    if (body) {
      check('status is not_enough_data or ok', body.ok === true || body.status === 'not_enough_data');
      check('no server error', body.status !== 'error' && body.status !== 'internal_error');
    }
  }

  // ── 2. Correlation with explicit datasetIds (if provided) ─────────────────
  if (SPY_ID && NFLX_ID) {
    const body = await runCase(
      'Correlation — explicit datasetIds SPY+NFLX',
      `/api/macro/correlation?symbols=SPY,NFLX&window=5&timeframe=1d&datasetIds=${SPY_ID},${NFLX_ID}`
    );
    if (body) {
      if (body.status === 'ready') {
        check('ok true', body.ok === true);
        check('alignedRows >= 5', body.observations >= 5, `got ${body.observations}`);
        check('matrix is 2x2', Array.isArray(body.matrix) && body.matrix.length === 2);
        if (body.matrix.length === 2) {
          const corr = body.matrix[0][1];
          check('off-diagonal finite', Number.isFinite(corr), `got ${corr}`);
          check('correlation in [-1,1]', corr >= -1 && corr <= 1, `got ${corr}`);
        }
        check('resolution field present', typeof body.resolution === 'string');
      } else if (body.status === 'not_enough_data') {
        warn('not enough data', `observations=${body.observations} — datasets may be too short`);
        if (body.diagnostics) {
          check('diagnostics.reason present', typeof body.diagnostics.reason === 'string');
          check('parsedSeries present', Array.isArray(body.diagnostics.parsedSeries));
        } else {
          check('diagnostics present in not_enough_data', false, 'missing diagnostics field');
        }
      } else if (body.status === 'dataset_not_found') {
        warn('dataset not found in production registry', JSON.stringify(body));
      } else if (body.status === 'missing_symbols') {
        check('action field present', typeof body.action === 'string');
      }
    }
  } else {
    warn('SPY_ID and NFLX_ID not set — skipping explicit datasetIds test',
      'Set SPY_ID and NFLX_ID env vars to test with real production dataset IDs');
  }

  // ── 3. Beta — no dataset (baseline) ──────────────────────────────────────
  {
    const body = await runCase(
      'Beta — no dataset (baseline)',
      '/api/macro/beta?asset=NFLX&benchmark=SPY&window=5'
    );
    if (body) {
      check('ok field present', 'ok' in body);
      check('status field present', typeof body.status === 'string');
      check('no server error', body.status !== 'error' && body.status !== 'internal_error');
    }
  }

  // ── 4. Beta — explicit datasetIds (if provided) ───────────────────────────
  if (SPY_ID && NFLX_ID) {
    const body = await runCase(
      'Beta — explicit datasetIds SPY+NFLX',
      `/api/macro/beta?asset=NFLX&benchmark=SPY&window=5&datasetIds=${SPY_ID},${NFLX_ID}`
    );
    if (body) {
      if (body.status === 'ready') {
        check('ok true', body.ok === true);
        check('beta finite', Number.isFinite(body.beta), `got ${body.beta}`);
        check('r2 finite', Number.isFinite(body.r2), `got ${body.r2}`);
        check('observations >= 5', body.observations >= 5, `got ${body.observations}`);
        check('resolution field present', typeof body.resolution === 'string');
      } else if (body.status === 'not_enough_data') {
        warn('not enough data for beta', `observations=${body.observations}`);
      } else if (body.status === 'dataset_not_found') {
        warn('dataset not found in production registry', JSON.stringify(body));
      }
    }
  }

  // ── 5. Sector-rotation (stability check) ─────────────────────────────────
  {
    const body = await runCase(
      'Sector-rotation (stability)',
      '/api/macro/sector-rotation?symbols=SPY,QQQ&window=20'
    );
    if (body) {
      check('ok field present', 'ok' in body);
      check('sectors array present', Array.isArray(body.sectors));
    }
  }

  // ── 6. Volatility-heatmap (stability check) ───────────────────────────────
  {
    const body = await runCase(
      'Volatility-heatmap (stability)',
      '/api/macro/volatility-heatmap?symbols=SPY,QQQ&window=20&timeframe=1d'
    );
    if (body) {
      check('ok field present', 'ok' in body);
      check('items or status present', 'items' in body || 'status' in body);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  const warnings = results.filter((r) => r.ok === 'warn').length;
  console.log(`Total: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  if (failed > 0) {
    console.log('\nFailed checks:');
    results.filter((r) => r.ok === false).forEach((r) => console.log(`  ✗ ${r.label}${r.detail ? ': ' + r.detail : ''}`));
    process.exit(1);
  } else {
    console.log('\nAll checks passed.');
  }
}

main().catch((err) => {
  console.error('Smoke script error:', err);
  process.exit(1);
});
