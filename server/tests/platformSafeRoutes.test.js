import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let baseUrl;
let server;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

test.before(async () => {
  const [mlRoutes, portfolioRoutes, riskRoutes, feedRoutes, providerRoutes] = await Promise.all([
    import('../api/mlRoutes.js').then((m) => m.default),
    import('../api/portfolioRoutes.js').then((m) => m.default),
    import('../api/riskRoutes.js').then((m) => m.default),
    import('../api/feedRoutes.js').then((m) => m.default),
    import('../api/providerCredentialRoutes.js').then((m) => m.default),
  ]);
  const app = express();
  app.use(express.json());
  app.use('/api/ml', mlRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use('/api/risk', riskRoutes);
  app.use('/api/feeds', feedRoutes);
  app.use('/api/feed', feedRoutes);
  app.use('/api/providers', providerRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('all required ML empty-state endpoints are mounted and non-404', async () => {
  const endpoints = [
    ['/api/ml/health', ['ok', 'status', 'worker']],
    ['/api/ml/model', ['ok', 'champion', 'challengers', 'status']],
    ['/api/ml/model-runs', ['ok', 'runs']],
    ['/api/ml/predictions', ['ok', 'predictions']],
    ['/api/ml/feature-importance', ['ok', 'features']],
    ['/api/ml/drift', ['ok', 'drift']],
    ['/api/ml/model-card', ['ok', 'modelCard', 'status']],
  ];

  for (const [endpoint, keys] of endpoints) {
    const { response, body } = await request(endpoint, { headers: { accept: 'application/json' } });
    assert.notEqual(response.status, 404, endpoint);
    assert.equal(response.status, 200, endpoint);
    for (const key of keys) assert.ok(Object.hasOwn(body, key), `${endpoint} missing ${key}`);
  }
});

test('ML health exposes required availability contract without requiring worker', async () => {
  const { response, body } = await request('/api/ml/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'available');
  assert.equal(typeof body.worker.available, 'boolean');
  assert.equal(body.worker.available ? body.worker.mode : 'not_configured', body.worker.mode);
});

test('portfolio endpoints return safe empty contracts and never raw 404', async () => {
  const expectedKeys = [
    ['/api/portfolio/summary', 'summary'],
    ['/api/portfolio/positions', 'positions'],
    ['/api/portfolio/pnl', 'pnl'],
    ['/api/portfolio/exposure', 'exposure'],
    ['/api/portfolio/drawdown', 'drawdown'],
    ['/api/portfolio/history', 'history'],
  ];

  for (const [endpoint, key] of expectedKeys) {
    const { response, body } = await request(endpoint);
    assert.notEqual(response.status, 404, endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.equal(body.ok, true, endpoint);
    assert.ok(Object.hasOwn(body, key) || endpoint.endsWith('/summary'), `${endpoint} missing ${key}`);
  }
});

test('risk endpoints return safe empty contracts and never raw 404', async () => {
  const expectedKeys = [
    ['/api/risk/summary', 'risk'],
    ['/api/risk/limits', 'limits'],
    ['/api/risk/var', 'var'],
    ['/api/risk/drawdown', 'drawdown'],
    ['/api/risk/exposure', 'exposure'],
    ['/api/risk/alerts', 'alerts'],
  ];

  for (const [endpoint, key] of expectedKeys) {
    const { response, body } = await request(endpoint);
    assert.notEqual(response.status, 404, endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.equal(body.ok, true, endpoint);
    assert.ok(Object.hasOwn(body, key), `${endpoint} missing ${key}`);
  }

  const summary = await request('/api/risk/summary');
  assert.equal(summary.body.risk.status, 'not_enough_data');
});

test('feed live data smoke endpoints are mounted and parse as JSON without fake data assertions', async () => {
  for (const endpoint of ['/api/feeds/tick/SPY', '/api/feeds/candle/SPY', '/api/feeds/orderbook/SPY', '/api/feed/status']) {
    const { response, body } = await request(endpoint);
    assert.notEqual(response.status, 404, endpoint);
    assert.equal(response.status, 200, endpoint);
    assert.equal(body.success, true, endpoint);
  }
});
