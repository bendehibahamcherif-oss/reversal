import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import backtestRoutes from '../api/backtestRoutes.js';
import { sanitizeJson } from '../utils/apiResponse.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/backtest', backtestRoutes);
  app.use('/api', (req, res) => res.status(404).json(sanitizeJson({
    ok: false,
    status: 'endpoint_not_found',
    message: 'API endpoint not found.',
    endpoint: req.originalUrl || req.path,
    method: req.method,
  })));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json(sanitizeJson({ ok: false, status: 'internal_error', message: err.message, requestId: 'test' }));
  });
  return app;
}

async function request(app, path) {
  return new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      const response = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
      const text = await response.text();
      server.close(() => resolve({ response, text, body: JSON.parse(text) }));
    });
  });
}

test('canonical GET /api/backtest/runs returns JSON run list without requiring a symbol', async () => {
  const { response, text, body } = await request(makeApp(), '/api/backtest/runs');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.doesNotMatch(text, /<!doctype|<html|\bNaN\b|-?Infinity/);
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.runs));
});

test('unknown /api route returns endpoint_not_found JSON with method and endpoint', async () => {
  const { response, text, body } = await request(makeApp(), '/api/not-mounted');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.doesNotMatch(text, /<!doctype|<html|\bNaN\b|-?Infinity/);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'endpoint_not_found');
  assert.equal(body.method, 'GET');
  assert.equal(body.endpoint, '/api/not-mounted');
});

// Regression for the JSON sanitizer used by global API 404/error handlers.
test('sanitizeJson removes non-finite and unserializable values from API payloads', () => {
  const circular = { value: Number.NaN, inf: Infinity, when: new Date('2026-06-06T00:00:00Z'), big: 10n };
  circular.self = circular;
  const safe = sanitizeJson(circular);
  assert.deepEqual(safe, {
    value: null,
    inf: null,
    when: '2026-06-06T00:00:00.000Z',
    big: '10',
    self: null,
  });
  assert.doesNotThrow(() => JSON.stringify(safe));
});
