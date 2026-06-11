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

/** Write a single-symbol CSV fixture: only NFLX. */
function writeNflxOnlyCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let price = 500;
  for (let i = 0; i < 60; i++) {
    const drift = Math.cos(i / 3) * 3;
    const ts = 1700000000000 + i * 86400000;
    price = Math.max(200, price + drift);
    rows.push(`${ts},NFLX,${price.toFixed(2)},${(price+2).toFixed(2)},${(price-2).toFixed(2)},${price.toFixed(2)},500000`);
  }
  const csvPath = join(dir, 'nflx_only.csv');
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

/**
 * Patch the registry with a record that includes explicit symbol metadata,
 * so that findCompatibleDatasetsForSymbols can discover it during auto-resolution.
 */
async function patchRegistryWithSymbol(datasetId, csvPath, symbol) {
  return import('../historical/historicalDatasetRegistry.js').then(({ historicalDatasetRegistry }) => {
    const registry = historicalDatasetRegistry;
    const record = {
      datasetId, id: datasetId,
      symbol: symbol || '',
      symbols: symbol ? [symbol.toUpperCase()] : [],
      timeframe: '1d',
      provider: 'yahoo',
      status: 'ready',
      rowCount: 60,
      files: { csv: csvPath, json: null, parquet: null },
      filePath: csvPath,
    };
    if (typeof registry.saveDataset === 'function') {
      registry.saveDataset(record);
    } else {
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

  const twoSymCsv   = writeTwoSymbolCsv(tmpDir);
  const spyOnlyCsv  = writeSpyOnlyCsv(tmpDir);
  const nflxOnlyCsv = writeNflxOnlyCsv(tmpDir);
  const tinyCsv     = writeTinyTwoSymbolCsv(tmpDir);

  ids = {
    twoSymbol: 'macro_test_two_symbol',
    spyOnly:   'macro_test_spy_only',
    nflxOnly:  'macro_test_nflx_only',
    tiny:      'macro_test_tiny',
  };

  await Promise.all([
    patchRegistry(ids.twoSymbol, twoSymCsv),
    patchRegistryWithSymbol(ids.spyOnly,  spyOnlyCsv,  'SPY'),
    patchRegistryWithSymbol(ids.nflxOnly, nflxOnlyCsv, 'NFLX'),
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

  it('returns missing_symbols when MSFT not in any dataset', async () => {
    const { status, body } = await get(`/api/macro/correlation?datasetId=${ids.spyOnly}&symbols=SPY,MSFT&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.deepEqual(body.missingSymbols, ['MSFT']);
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

  it('returns missing_symbols when MSFT not in any dataset', async () => {
    const { status, body } = await get(`/api/macro/beta?datasetId=${ids.spyOnly}&asset=MSFT&benchmark=SPY`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.ok(body.missingSymbols.includes('MSFT'));
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

// ── Multi-dataset auto-resolution ─────────────────────────────────────────────

describe('Correlation — multi-dataset auto-resolution', () => {
  it('auto-resolves SPY from registry when primary dataset is NFLX-only', async () => {
    // Primary dataset: NFLX only. Registry has SPY-only dataset.
    // Backend should auto-find the SPY dataset and compute correlation.
    const { status, body } = await get(`/api/macro/correlation?datasetId=${ids.nflxOnly}&symbols=SPY,NFLX&window=20&timeframe=1d`);
    assert.equal(status, 200);
    assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'ready', `expected status=ready, got: ${body.status} (${body.message})`);
    assert.equal(body.resolution, 'multi_dataset');
    assert.ok(typeof body.datasetsBySymbol === 'object');
    assert.ok(body.datasetsBySymbol.SPY, 'datasetsBySymbol.SPY should be set');
    assert.ok(body.datasetsBySymbol.NFLX, 'datasetsBySymbol.NFLX should be set');
    assert.ok(Array.isArray(body.matrix) && body.matrix.length === 2);
    const corr = body.matrix[0][1];
    assert.ok(Number.isFinite(corr), `off-diagonal must be finite, got ${corr}`);
    assert.ok(corr >= -1 && corr <= 1);
    assert.ok(!hasNonFinite(body));
  });

  it('returns ready when called with explicit datasetIds for SPY and NFLX', async () => {
    const { status, body } = await get(
      `/api/macro/correlation?datasetIds=${ids.spyOnly},${ids.nflxOnly}&symbols=SPY,NFLX&window=20&timeframe=1d`
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'ready');
    assert.equal(body.resolution, 'multi_dataset');
    assert.ok(Array.isArray(body.matrix) && body.matrix.length === 2);
    assert.ok(!hasNonFinite(body));
  });

  it('returns missing_symbols with action=create_dataset when no compatible dataset exists for MSFT', async () => {
    const { status, body } = await get(`/api/macro/correlation?datasetId=${ids.spyOnly}&symbols=SPY,MSFT&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.ok(body.missingSymbols.includes('MSFT'));
    assert.equal(body.action, 'create_dataset');
    assert.ok(!hasNonFinite(body));
  });

  it('beta auto-resolves NFLX from registry when primary is SPY-only', async () => {
    const { status, body } = await get(`/api/macro/beta?datasetId=${ids.spyOnly}&asset=NFLX&benchmark=SPY&window=20`);
    assert.equal(status, 200);
    assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'ready');
    assert.equal(body.resolution, 'multi_dataset');
    assert.ok(Number.isFinite(body.beta));
    assert.ok(Number.isFinite(body.r2));
    assert.ok(!hasNonFinite(body));
  });

  it('beta returns missing_symbols with action when MSFT has no dataset', async () => {
    const { status, body } = await get(`/api/macro/beta?datasetId=${ids.spyOnly}&asset=MSFT&benchmark=SPY`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'missing_symbols');
    assert.ok(body.missingSymbols.includes('MSFT'));
    assert.equal(body.action, 'create_dataset');
    assert.ok(!hasNonFinite(body));
  });
});

// ── ISO timestamp regression tests ────────────────────────────────────────────
// Production Yahoo datasets use ISO 8601 timestamps ("2026-06-11T00:00:00.000Z").
// The old timeOf() did Number(isoString) which is NaN → all candles dropped → alignedRows 0.

/** Write SPY CSV using ISO 8601 timestamps (canonical production format). */
function writeIsoSpyCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let price = 400;
  for (let i = 0; i < 10; i++) {
    const drift = Math.sin(i / 4) * 2;
    price = Math.max(300, price + drift);
    const date = new Date(Date.UTC(2026, 5, 1 + i)).toISOString(); // 2026-06-01T00:00:00.000Z
    rows.push(`${date},SPY,${price.toFixed(2)},${(price+1).toFixed(2)},${(price-1).toFixed(2)},${price.toFixed(2)},1000000`);
  }
  const csvPath = join(dir, 'iso_spy.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

/** Write NFLX CSV using ISO 8601 timestamps — same dates as ISO SPY fixture. */
function writeIsoNflxCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let price = 500;
  for (let i = 0; i < 10; i++) {
    const drift = Math.cos(i / 3) * 3;
    price = Math.max(200, price + drift);
    const date = new Date(Date.UTC(2026, 5, 1 + i)).toISOString();
    rows.push(`${date},NFLX,${price.toFixed(2)},${(price+2).toFixed(2)},${(price-2).toFixed(2)},${price.toFixed(2)},500000`);
  }
  const csvPath = join(dir, 'iso_nflx.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

/** Write SPY CSV using the external Yahoo Finance format: Date,Open,High,Low,Close,Volume (no symbol column). */
function writeExternalYahooCsv(dir, symbol, startPrice) {
  const rows = ['Date,Open,High,Low,Close,Volume'];
  let price = startPrice;
  for (let i = 0; i < 10; i++) {
    const drift = Math.sin(i / 4) * 2;
    price = Math.max(100, price + drift);
    const d = `2026-06-${String(1 + i).padStart(2, '0')}`;
    rows.push(`${d},${price.toFixed(2)},${(price+1).toFixed(2)},${(price-1).toFixed(2)},${price.toFixed(2)},1000000`);
  }
  const csvPath = join(dir, `yahoo_${symbol.toLowerCase()}.csv`);
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

/** Write a CSV with no close column at all. */
function writeNoCloseCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,volume'];
  rows.push('2026-06-01T00:00:00.000Z,SPY,400,401,399,1000000');
  const csvPath = join(dir, 'no_close.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

/** Write two datasets that share NO overlapping dates. */
function writeNoOverlapSpyCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let price = 400;
  for (let i = 0; i < 5; i++) {
    price += 1;
    rows.push(`${new Date(Date.UTC(2026, 0, 1 + i)).toISOString()},SPY,${price},${price+1},${price-1},${price},1000000`);
  }
  const csvPath = join(dir, 'no_overlap_spy.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}
function writeNoOverlapNflxCsv(dir) {
  const rows = ['timestamp,symbol,open,high,low,close,volume'];
  let price = 500;
  for (let i = 0; i < 5; i++) {
    price += 2;
    rows.push(`${new Date(Date.UTC(2026, 6, 1 + i)).toISOString()},NFLX,${price},${price+1},${price-1},${price},500000`);
  }
  const csvPath = join(dir, 'no_overlap_nflx.csv');
  writeFileSync(csvPath, rows.join('\n'));
  return csvPath;
}

describe('ISO timestamp alignment — production dataset format', () => {
  let isoIds;
  before(async () => {
    const isoSpyCsv  = writeIsoSpyCsv(tmpDir);
    const isoNflxCsv = writeIsoNflxCsv(tmpDir);
    isoIds = { spy: 'iso_test_spy', nflx: 'iso_test_nflx' };
    await Promise.all([
      patchRegistryWithSymbol(isoIds.spy,  isoSpyCsv,  'SPY'),
      patchRegistryWithSymbol(isoIds.nflx, isoNflxCsv, 'NFLX'),
    ]);
  });

  it('correlation with ISO timestamp datasets returns ready, not not_enough_data', async () => {
    const { status, body } = await get(
      `/api/macro/correlation?datasetIds=${isoIds.spy},${isoIds.nflx}&symbols=SPY,NFLX&window=5&timeframe=1d`
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body.diagnostics ?? body)}`);
    assert.equal(body.status, 'ready', `got status=${body.status}: ${JSON.stringify(body.diagnostics ?? {})}`);
    assert.ok(body.observations >= 5, `expected >= 5 aligned rows, got ${body.observations}`);
    assert.ok(Array.isArray(body.matrix) && body.matrix.length === 2);
    const corr = body.matrix[0][1];
    assert.ok(Number.isFinite(corr), `off-diagonal must be finite, got ${corr}`);
    assert.ok(corr >= -1 && corr <= 1);
    assert.ok(!hasNonFinite(body));
  });

  it('beta with ISO timestamp datasets returns finite beta and r2', async () => {
    const { status, body } = await get(
      `/api/macro/beta?datasetIds=${isoIds.spy},${isoIds.nflx}&asset=NFLX&benchmark=SPY&window=5`
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true, `expected ok=true, got: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'ready');
    assert.ok(Number.isFinite(body.beta), `beta must be finite, got ${body.beta}`);
    assert.ok(Number.isFinite(body.r2),   `r2 must be finite, got ${body.r2}`);
    assert.ok(body.observations >= 5);
    assert.ok(!hasNonFinite(body));
  });

  it('not_enough_data response includes structured diagnostics when overlap is insufficient', async () => {
    // Use a 2-row dataset (only 1 return each) — fewer than 2 aligned pairs → not_enough_data
    const { status, body } = await get(
      `/api/macro/correlation?datasetId=${ids.tiny}&symbols=SPY,NFLX&window=5`
    );
    assert.equal(status, 200);
    assert.equal(body.status, 'not_enough_data');
    assert.ok(body.diagnostics, 'diagnostics must be present');
    assert.ok(typeof body.diagnostics.reason === 'string', 'diagnostics.reason must be a string');
    assert.ok(Array.isArray(body.diagnostics.parsedSeries), 'parsedSeries must be array');
    // parsedSeries must show actual parsed row counts (not 0) — the data loaded, just not enough overlap
    for (const s of body.diagnostics.parsedSeries) {
      assert.ok(s.returnCount >= 0, `${s.symbol} returnCount must be >= 0, got ${s.returnCount}`);
    }
    assert.ok(!hasNonFinite(body));
  });
});

describe('External CSV format — Date/Close columns (Yahoo Finance export style)', () => {
  let extIds;
  before(async () => {
    const extSpyCsv  = writeExternalYahooCsv(tmpDir, 'SPY',  400);
    const extNflxCsv = writeExternalYahooCsv(tmpDir, 'NFLX', 500);
    extIds = { spy: 'ext_test_spy', nflx: 'ext_test_nflx' };
    await Promise.all([
      patchRegistryWithSymbol(extIds.spy,  extSpyCsv,  'SPY'),
      patchRegistryWithSymbol(extIds.nflx, extNflxCsv, 'NFLX'),
    ]);
  });

  it('external Date/Close CSV aligns and produces finite correlation', async () => {
    const { status, body } = await get(
      `/api/macro/correlation?datasetIds=${extIds.spy},${extIds.nflx}&symbols=SPY,NFLX&window=5&timeframe=1d`
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true, `expected ok=true: ${JSON.stringify(body.diagnostics ?? body)}`);
    assert.equal(body.status, 'ready');
    assert.ok(body.observations >= 5);
    const corr = body.matrix[0][1];
    assert.ok(Number.isFinite(corr));
    assert.ok(corr >= -1 && corr <= 1);
    assert.ok(!hasNonFinite(body));
  });
});

describe('Missing close column — returns diagnostic', () => {
  let noCloseId;
  before(async () => {
    const noCloseCsv = writeNoCloseCsv(tmpDir);
    noCloseId = 'no_close_test';
    await patchRegistryWithSymbol(noCloseId, noCloseCsv, 'SPY');
  });

  it('returns missing_symbols or not_enough_data, not a crash, when close column absent', async () => {
    const { status, body } = await get(
      `/api/macro/correlation?datasetId=${noCloseId}&symbols=SPY,NFLX&window=5`
    );
    assert.equal(status, 200);
    assert.ok(body.ok === false || body.status === 'not_enough_data' || body.status === 'missing_symbols',
      `expected error state, got: ${JSON.stringify(body)}`);
    assert.ok(!hasNonFinite(body));
  });
});

describe('No overlapping dates — structured diagnostic, not silent 0', () => {
  let noOverlapIds;
  before(async () => {
    const spyCsv  = writeNoOverlapSpyCsv(tmpDir);
    const nflxCsv = writeNoOverlapNflxCsv(tmpDir);
    noOverlapIds = { spy: 'no_overlap_spy', nflx: 'no_overlap_nflx' };
    await Promise.all([
      patchRegistryWithSymbol(noOverlapIds.spy,  spyCsv,  'SPY'),
      patchRegistryWithSymbol(noOverlapIds.nflx, nflxCsv, 'NFLX'),
    ]);
  });

  it('returns not_enough_data with reason=no_overlap and both parsedSeries having data', async () => {
    const { status, body } = await get(
      `/api/macro/correlation?datasetIds=${noOverlapIds.spy},${noOverlapIds.nflx}&symbols=SPY,NFLX&window=5`
    );
    assert.equal(status, 200);
    assert.equal(body.status, 'not_enough_data');
    assert.ok(body.diagnostics, 'diagnostics must be present');
    assert.equal(body.diagnostics.reason, 'no_overlap');
    // Both series must have actual returns
    for (const s of body.diagnostics.parsedSeries) {
      assert.ok(s.returnCount > 0, `${s.symbol} must have returnCount > 0, got ${s.returnCount}`);
    }
    assert.ok(!hasNonFinite(body));
  });
});
