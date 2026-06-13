#!/usr/bin/env node
const API_BASE = (process.env.API_BASE || 'https://reversal.onrender.com').replace(/\/$/, '');
const datasetIds = 'hist_SPY_1d_RTH_20250612_20260612_yahoo,hist_NFLX_1d_RTH_20250612_20260612_yahoo';
const paths = [
  `/api/macro/correlation?symbols=SPY,NFLX&timeframe=1d&window=20&datasetIds=${datasetIds}`,
  `/api/macro/beta?asset=NFLX&benchmark=SPY&symbols=SPY,NFLX&timeframe=1d&window=20&datasetIds=${datasetIds}`,
];

function finite(value) { return Number.isFinite(Number(value)); }

let failed = false;
for (const path of paths) {
  const url = `${API_BASE}${path}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) throw new Error(`${path} returned non-JSON content-type ${contentType}`);
  const body = await response.json();
  console.log(JSON.stringify({ path, status: response.status, body }, null, 2));
  if (response.status >= 500) throw new Error(`${path} returned ${response.status}`);
  if (body.status === 'dataset_not_found' || body.reason === 'dataset_not_found') continue;
  if (path.includes('/correlation')) {
    const corr = body.pairs?.[0]?.correlation ?? body.matrix?.[0]?.[1];
    if (!(body.alignedRows > 20 && finite(corr))) failed = true;
  } else {
    if (!(body.alignedRows > 20 && finite(body.beta) && finite(body.r2))) failed = true;
  }
}
if (failed) process.exitCode = 1;
