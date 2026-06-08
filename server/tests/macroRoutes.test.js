import test, { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// ── Test fixture helpers ──────────────────────────────────────────────────────

function makeTmpDir() {
  return os.tmpdir() + '/macro-test-' + Math.random().toString(36).slice(2);
}

/** Write a multi-symbol CSV fixture: SPY + NFLX, ~60 rows each with real price variation. */
function writeTwoSymbolCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let spyPrice = 400;
  let nflxPrice = 500;
  for (let i = 0; i < 60; i++) {
    const spyDrift  = (Math.sin(i / 4) * 2);
    const nflxDrift = (Math.cos(i / 3) * 3);
    const ts = 1700000000000 + i * 86400000;
    spyPrice  = Math.max(300, spyPrice  + spyDrift);
    nflxPrice = Math.max(200, nflxPrice + nflxDrift);
    rows.push(`${ts},SPY,${spyPrice.toFixed(2)},${(spyPrice+1).toFixed(2)},${(spyPrice-1).toFixed(2)},${spyPrice.toFixed(2)},1000000`);
    rows.push(`${ts},NFLX,${nflxPrice.toFixed(2)},${(nflxPrice+2).toFixed(2)},${(nflxPrice-2).toFixed(2)},${nflxPrice.toFixed(2)},500000`);
  }
  const csvPath = join(dir, 'spy_nflx_test.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

/** Write a single-symbol CSV fixture: only SPY. */
function writeSpyOnlyCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let price = 400;
  for (let i = 0; i < 60; i++) {
    const drift = Math.sin(i / 4) * 2;
    const ts = 1700000000000 + i * 86400000;
    price = Math.max(300, price + drift);
    rows.push(`${ts},SPY,${price.toFixed(2)},${(price+1).toFixed(2)},${(price-1).toFixed(2)},${price.toFixed(2)},1000000`);
  }
  const csvPath = join(dir, 'spy_only.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

/**
 * Write a 4-row CSV (2 rows per symbol, 2 different timestamps).
 * Each symbol gets 1 return, aligned → 1 pair total.
 * 1 pair < 2 required → not_enough_data (neither symbol is flagged missing).
 */
function writeTinyTwoSymbolCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  rows.push(`1700000000000,SPY,400,401,399,400,100000`);
  rows.push(`1700086400000,SPY,401,402,400,401,100000`);
  rows.push(`1700000000000,NFLX,500,502,498,500,50000`);
  rows.push(`1700086400000,NFLX,502,504,500,502,50000`);
  const csvPath = join(dir, 'tiny_two.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

// ── Minimal registry stub ─────────────────────────────────────────────────────

/**
 * Patch the historicalDatasetRegistry singleton with a test record so that
 * readDatasetCandlesAsync finds the dataset by ID.
 */
function patchRegistry(datasetId, csvPath) {
  // We import the singleton live; patch its in-memory store
  return import('../historical/historicalDatasetRegistry.js').then(({ historicalDatasetRegistry }) => {
    const registry = historicalDatasetRegistry;
    if (typeof registry._datasets !== 'undefined') {
      // direct map access
      registry._datasets = registry._datasets ?? new Map();
    }
    // Patch via saveDataset if available, otherwise stub get()
    const record = {
      datasetId, id: datasetId, symbols: [],
      files: { csv: csvPath, json: null, parquet: null },
      filePath: csvPath, status: 'ready', rowCount: 60,
    };
    if (typeof registry.saveDataset === 'function') {
      registry.saveDataset(record);
    } else {
      // Monkey-patch get() to serve the fixture for this datasetId
      const origGet = registry.get.bind(registry);
      registry.get = (id) => (id === datasetId ? record : origGet(id));
    }
    return record;
  });
}

// ── Test setup ────────────────────────────────────────────────────────────────

let baseUrl;
let server;
let tmpDir;
let ids;

before(async () => {
  tmpDir = makeTmpDir();
  mkdirSync(tmpDir, { recursive: true });

  const twoSymCsv  = writeTwoSymbolCsv(tmpDir);
  const spyOnlyCsv = writeSpyOnlyCsv(tmpDir);
  const tinyCsv    = writeTinyTwoSymbolCsv(tmpDir);

  ids = {
    twoSymbol: 'macro_test_two_symbol',
    spyOnly:   'macro_test_spy_only',
    tiny:      'macro_test_tiny',
  };

  await Promise.all([
    patchRegistry(ids.twoSymbol, twoSymCsv),
    patchRegistry(ids.spyOnly,   spyOnlyCsv),
    patchRegistry(ids.tiny,      tinyCsv),
  ]);

  const [macroRoutes, multiAssetRoutes] = await Promise.all([
    import('../api/macroRoutes.js').then((m) => m.default),
    import('../api/multiAssetRoutes.js').then((m) => m.default),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/macro', macroRoutes);
  app.use('/api/multi-asset', multiAssetRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function get(path) {
  return fetch(`${baseUrl}${path}`, { headers: { accept: 'application/json' } })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}

function hasNonFinite(body) {
  const s = JSON.stringify(body);
  return /\bNaN\b|\bInfinity\b/.test(s);
}

// ── Compatibility contract ────────────────────────────────────────────────────

test('macro compatibility routes return valid JSON contracts', async () => {
  const endpoints = [
    ['/api/macro/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', ['ok', 'symbols', 'matrix', 'status']],
    ['/api/macro/beta?asset=QQQ&benchmark=SPY&window=20', ['ok', 'asset', 'benchmark', 'beta', 'r2', 'status']],
    ['/api/macro/sector-rotation?window=20&timeframe=1d&benchmark=SPY', ['ok', 'sectors', 'status']],
    ['/api/macro/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', ['ok', 'symbols', 'items', 'status']],
    ['/api/multi-asset/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', ['ok', 'symbols', 'heatmap']],
  ];
  for (const [endpoint, keys] of endpoints) {
    const { status, body } = await get(endpoint);
    assert.equal(status, 200, `${endpoint} should be 200`);
    for (const key of keys) assert.ok(Object.hasOwn(body, key), `${endpoint} missing ${key}`);
    assert.ok(!hasNonFinite(body), `${endpoint} must not contain NaN/Infinity`);
  }
});

// ── Correlation with two-symbol dataset ──────────────────────────────────────

describe('Correlation — two-symbol dataset', () => {
  it('returns finite matrix when both SPY and NFLX are present', async () => {
    const { status, body } = await get(`/api/macro/correlation?datasetId=${ids.twoSymbol}&symbols=SPY,NFLX&window=20&timeframe=1d`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ready');
    assert.ok(Array.isArray(body.matrix), 'matrix should be array');
    assert.equal(body.matrix.length, 2);
    assert.equal(body.matrix[0].length, 2);
    // Diagonal must be 1
    assert.equal(body.matrix[0][0], 1);
    assert.equal(body.matrix[1][1], 1);
    // Off-diagonal must be finite numbers in [-1, 1]
    const corr = body.matrix[0][1];
    assert.ok(Number.isFinite(corr), `off-diagonal must be finite, got ${corr}`);
    assert.ok(corr >= -1 && corr <= 1, `correlation must be in [-1,1], got ${corr}`);
    // pairs array
    assert.ok(Array.isArray(body.pairs) && body.pairs.length > 0, 'pairs should be non-empty');
    assert.ok(!hasNonFinite(body), 'must not contain NaN/Infinity');
  });

  it('returns missing_symbols when NFLX not in dataset', async () => {
    const { status, body } = await get(`/api/macro/correlation?datasetId=${ids.spyOnly}&symbols=SPY,NFLX&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.deepEqual(body.missingSymbols, ['NFLX']);
    assert.deepEqual(body.availableSymbols, ['SPY']);
    assert.ok(!hasNonFinite(body));
  });

  it('returns not_enough_data when overlap is insufficient', async () => {
    const { status, body } = await get(`/api/macro/correlation?datasetId=${ids.tiny}&symbols=SPY,NFLX&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'not_enough_data');
    assert.deepEqual(body.matrix, []);
    assert.ok(!hasNonFinite(body));
  });

  it('returns not_enough_data with no dataset selected', async () => {
    const { status, body } = await get('/api/macro/correlation?symbols=SPY,NFLX&window=20');
    assert.equal(status, 200);
    assert.equal(body.status, 'not_enough_data');
    assert.ok(!hasNonFinite(body));
  });
});

// ── Beta ──────────────────────────────────────────────────────────────────────

describe('Beta — two-symbol dataset', () => {
  it('returns finite beta and r2 for NFLX vs SPY', async () => {
    const { status, body } = await get(`/api/macro/beta?datasetId=${ids.twoSymbol}&asset=NFLX&benchmark=SPY&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ready');
    assert.ok(Number.isFinite(body.beta), `beta must be finite, got ${body.beta}`);
    assert.ok(Number.isFinite(body.r2),   `r2 must be finite, got ${body.r2}`);
    assert.ok(body.r2 >= 0 && body.r2 <= 1, `r2 must be in [0,1], got ${body.r2}`);
    assert.ok(body.observations > 0);
    assert.ok(!hasNonFinite(body));
  });

  it('returns missing_symbols when NFLX not in dataset', async () => {
    const { status, body } = await get(`/api/macro/beta?datasetId=${ids.spyOnly}&asset=NFLX&benchmark=SPY`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.ok(body.missingSymbols.includes('NFLX'));
    assert.ok(!hasNonFinite(body));
  });

  it('returns not_enough_data with no dataset selected', async () => {
    const { status, body } = await get('/api/macro/beta?asset=NFLX&benchmark=SPY');
    assert.equal(status, 200);
    assert.equal(body.beta, null);
    assert.equal(body.status, 'not_enough_data');
    assert.ok(!hasNonFinite(body));
  });
});

// ── Volatility heatmap ────────────────────────────────────────────────────────

describe('Volatility heatmap', () => {
  it('returns finite realizedVol for SPY and NFLX', async () => {
    const { status, body } = await get(`/api/macro/volatility-heatmap?datasetId=${ids.twoSymbol}&symbols=SPY,NFLX&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ready');
    assert.ok(Array.isArray(body.items) && body.items.length === 2);
    for (const item of body.items) {
      assert.ok(Number.isFinite(item.realizedVol), `${item.symbol} realizedVol must be finite`);
      assert.ok(item.realizedVol > 0, `${item.symbol} realizedVol must be positive`);
    }
    assert.ok(!hasNonFinite(body));
  });

  it('returns missing_symbols when NFLX absent', async () => {
    const { status, body } = await get(`/api/macro/volatility-heatmap?datasetId=${ids.spyOnly}&symbols=SPY,NFLX&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.ok(body.missingSymbols.includes('NFLX'));
    assert.ok(!hasNonFinite(body));
  });

  it('returns empty items with no dataset selected', async () => {
    const { status, body } = await get('/api/macro/volatility-heatmap?symbols=SPY,NFLX&window=20');
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
    assert.ok(!hasNonFinite(body));
  });
});

// ── Sector rotation ───────────────────────────────────────────────────────────

describe('Sector rotation', () => {
  it('returns sector_metadata_missing when sector data unavailable', async () => {
    const { status, body } = await get('/api/macro/sector-rotation?symbols=SPY,NFLX&window=20');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'not_available');
    assert.equal(body.reason, 'sector_metadata_missing');
    assert.ok(typeof body.message === 'string' && body.message.length > 0);
    assert.deepEqual(body.sectors, []);
    assert.ok(!hasNonFinite(body));
  });

  it('returns sector_metadata_missing even with datasetId', async () => {
    const { status, body } = await get(`/api/macro/sector-rotation?datasetId=${ids.twoSymbol}&symbols=SPY,NFLX`);
    assert.equal(status, 200);
    assert.equal(body.status, 'not_available');
    assert.equal(body.reason, 'sector_metadata_missing');
    assert.ok(!hasNonFinite(body));
  });
});

// ── No NaN/Infinity in any response ──────────────────────────────────────────

describe('NaN/Infinity guard', () => {
  it('all macro endpoints never emit NaN or Infinity', async () => {
    const endpoints = [
      `/api/macro/correlation?datasetId=${ids.twoSymbol}&symbols=SPY,NFLX&window=20`,
      `/api/macro/beta?datasetId=${ids.twoSymbol}&asset=NFLX&benchmark=SPY&window=20`,
      `/api/macro/volatility-heatmap?datasetId=${ids.twoSymbol}&symbols=SPY,NFLX&window=20`,
      '/api/macro/sector-rotation?symbols=SPY,NFLX&window=20',
      `/api/macro/correlation?datasetId=${ids.spyOnly}&symbols=SPY,NFLX&window=20`,
      `/api/macro/beta?datasetId=${ids.spyOnly}&asset=NFLX&benchmark=SPY`,
      '/api/macro/correlation?symbols=SPY,NFLX&window=20',
    ];
    for (const ep of endpoints) {
      const { body } = await get(ep);
      assert.ok(!hasNonFinite(body), `${ep} must not contain NaN/Infinity`);
    }
  });
});
