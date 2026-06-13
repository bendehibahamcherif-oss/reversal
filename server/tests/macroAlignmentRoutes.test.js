import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import macroRoutes from '../api/macroRoutes.js';
import { historicalDatasetRegistry } from '../historical/historicalDatasetRegistry.js';

let server;
let baseUrl;
let registryFile;
let initialRegistryJson;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-alignment-'));

const SPY_CSV = `date,open,high,low,close,volume
2026-06-01,100,101,99,100,1000
2026-06-02,100,102,99,101,1000
2026-06-03,101,103,100,102,1000
2026-06-04,102,104,101,103,1000
2026-06-05,103,105,102,104,1000
2026-06-08,104,106,103,105,1000
2026-06-09,105,107,104,106,1000
2026-06-10,106,108,105,107,1000
2026-06-11,107,109,106,108,1000
2026-06-12,108,110,107,109,1000
`;

const NFLX_CSV = `Date,Open,High,Low,Close,Volume
2026-06-01,500,505,495,500,1000
2026-06-02,500,510,498,505,1000
2026-06-03,505,515,500,510,1000
2026-06-04,510,520,505,515,1000
2026-06-05,515,525,510,520,1000
2026-06-08,520,530,515,525,1000
2026-06-09,525,535,520,530,1000
2026-06-10,530,540,525,535,1000
2026-06-11,535,545,530,540,1000
2026-06-12,540,550,535,545,1000
`;

function saveCsvDataset(datasetId, symbol, csv) {
  const filePath = path.join(tmpDir, `${datasetId}.csv`);
  fs.writeFileSync(filePath, csv);
  historicalDatasetRegistry.saveDataset({
    datasetId,
    id: datasetId,
    provider: 'yahoo',
    symbols: [symbol],
    symbol,
    timeframe: '1d',
    startDate: '2026-06-01',
    endDate: '2026-06-12',
    rowCount: csv.trim().split(/\r?\n/).length - 1,
    files: { csv: filePath, parquet: null, json: null },
    filePath,
    status: 'ready',
  });
  return filePath;
}

async function request(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { response, body: await response.json() };
}

test.before(async () => {
  const dirs = historicalDatasetRegistry.getDirectories();
  registryFile = join(dirs.DATA_DIR, 'datasets.json');
  initialRegistryJson = existsSync(registryFile) ? readFileSync(registryFile, 'utf-8') : null;
  const app = express();
  app.use('/api/macro', macroRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (initialRegistryJson == null) rmSync(registryFile, { force: true });
  else writeFileSync(registryFile, initialRegistryJson);
  rmSync(tmpDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

test('correlation and beta align explicit multi-dataset Yahoo CSV shapes', async () => {
  saveCsvDataset('macro_fixture_spy', 'SPY', SPY_CSV);
  saveCsvDataset('macro_fixture_nflx', 'NFLX', NFLX_CSV);

  const corr = await request('/api/macro/correlation?symbols=SPY,NFLX&window=5&timeframe=1d&datasetIds=macro_fixture_spy,macro_fixture_nflx');
  assert.equal(corr.body.status, 'ready');
  assert.ok(corr.body.alignedRows >= 5);
  assert.equal(corr.body.matrix.length, 2);
  assert.equal(corr.body.matrix[0].length, 2);
  assert.equal(corr.body.matrix[1].length, 2);
  for (const row of corr.body.matrix) for (const value of row) assert.ok(Number.isFinite(value));
  assert.deepEqual(corr.body.datasetsBySymbol, { SPY: 'macro_fixture_spy', NFLX: 'macro_fixture_nflx' });

  const beta = await request('/api/macro/beta?asset=NFLX&benchmark=SPY&symbols=SPY,NFLX&window=5&timeframe=1d&datasetIds=macro_fixture_spy,macro_fixture_nflx');
  assert.equal(beta.body.status, 'ready');
  assert.ok(Number.isFinite(beta.body.beta));
  assert.ok(Number.isFinite(beta.body.r2));
  assert.deepEqual(beta.body.datasetsBySymbol, { SPY: 'macro_fixture_spy', NFLX: 'macro_fixture_nflx' });
});

test('ISO datetime and YYYY-MM-DD dates align across datasets', async () => {
  saveCsvDataset('macro_iso_spy', 'SPY', SPY_CSV.replaceAll('2026-06-', '2026-06-').replace(/^2026-(.*)$/gm, '2026-$1T00:00:00.000Z'));
  saveCsvDataset('macro_iso_nflx', 'NFLX', NFLX_CSV);

  const corr = await request('/api/macro/correlation?symbols=SPY,NFLX&window=5&datasetIds=macro_iso_spy,macro_iso_nflx');
  assert.equal(corr.body.status, 'ready');
  assert.ok(corr.body.alignedRows >= 5);
});

test('missing close column returns no_close_column diagnostics', async () => {
  saveCsvDataset('macro_no_close_spy', 'SPY', 'date,open\n2026-06-01,100\n2026-06-02,101\n');
  saveCsvDataset('macro_no_close_nflx', 'NFLX', NFLX_CSV);

  const corr = await request('/api/macro/correlation?symbols=SPY,NFLX&datasetIds=macro_no_close_spy,macro_no_close_nflx');
  assert.equal(corr.body.ok, false);
  assert.equal(corr.body.reason, 'no_close_column');
  assert.equal(corr.body.alignedRows, 0);
  assert.equal(corr.body.diagnostics.rootCause, 'no_close_column');
});

test('no overlap returns no_overlap diagnostics', async () => {
  saveCsvDataset('macro_overlap_spy', 'SPY', SPY_CSV);
  saveCsvDataset('macro_no_overlap_nflx', 'NFLX', NFLX_CSV.replaceAll('2026-06-', '2026-07-'));

  const corr = await request('/api/macro/correlation?symbols=SPY,NFLX&datasetIds=macro_overlap_spy,macro_no_overlap_nflx');
  assert.equal(corr.body.ok, false);
  assert.equal(corr.body.reason, 'no_overlap');
  assert.equal(corr.body.alignedRows, 0);
  assert.equal(corr.body.diagnostics.commonDatesCount, 0);
});
