import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let baseUrl;
let server;

async function request(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { headers: { accept: 'application/json' } });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body, contentType };
}

test.before(async () => {
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

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('macro compatibility routes return valid JSON contracts', async () => {
  const endpoints = [
    ['/api/macro/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', ['ok', 'symbols', 'matrix', 'status']],
    ['/api/macro/beta?asset=QQQ&benchmark=SPY&window=20', ['ok', 'asset', 'benchmark', 'beta', 'r2', 'status']],
    ['/api/macro/sector-rotation?window=20&timeframe=1d&benchmark=SPY', ['ok', 'sectors', 'status']],
    ['/api/macro/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', ['ok', 'symbols', 'heatmap', 'status']],
    ['/api/multi-asset/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d', ['ok', 'symbols', 'heatmap']],
  ];

  for (const [endpoint, keys] of endpoints) {
    const { response, body, contentType } = await request(endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.match(contentType, /application\/json/, endpoint);
    for (const key of keys) assert.ok(Object.hasOwn(body, key), `${endpoint} missing ${key}`);
  }
});
