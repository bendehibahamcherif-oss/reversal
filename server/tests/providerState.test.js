import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const secureDir = path.resolve(process.cwd(), 'server/persistence/secure');
const credentialsFile = path.join(secureDir, 'providerCredentials.json');
const activeFile = path.join(secureDir, 'activeProviders.json');
const backup = new Map();
let baseUrl;
let server;
let feedManager;

function backupFile(file) {
  backup.set(file, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
}

function restoreFile(file) {
  const content = backup.get(file);
  if (content === null) {
    if (fs.existsSync(file)) fs.rmSync(file);
  } else {
    fs.writeFileSync(file, content);
  }
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  return { response, body };
}

test.before(async () => {
  fs.mkdirSync(secureDir, { recursive: true });
  backupFile(credentialsFile);
  backupFile(activeFile);
  fs.writeFileSync(credentialsFile, JSON.stringify({ version: 1, records: [] }, null, 2));
  fs.writeFileSync(activeFile, JSON.stringify({ providers: ['yahoo', 'fallback_demo'], enabledByProvider: { yahoo: true, fallback_demo: true }, symbols: [] }, null, 2));
  delete process.env.ALPHA_VANTAGE_API_KEY;
  delete process.env.ALPHAVANTAGE_API_KEY;
  delete process.env.ALPHA_VANTAGE_KEY;

  const marketStreamRoutes = (await import('../api/marketStreamRoutes.js')).default;
  const providerRoutes = (await import('../api/providerCredentialRoutes.js')).default;
  const feedRoutes = (await import('../api/feedRoutes.js')).default;
  feedManager = (await import('../feeds/feedManager.js')).feedManager;
  const app = express();
  app.use(express.json());
  app.use('/api', marketStreamRoutes);
  app.use('/api/providers', providerRoutes);
  app.use('/api/feed', feedRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  restoreFile(credentialsFile);
  restoreFile(activeFile);
});

test('saving alphaVantage credentials returns configured and masks the key', async () => {
  const apiKey = 'ALPHATESTKEY1234';
  const { response, body } = await request('/api/providers/credentials/alphaVantage', { method: 'POST', body: JSON.stringify({ apiKey }) });
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.credentials.configured, true);
  assert.equal(body.credentials.source, 'backend');
  assert.notEqual(body.credentials.masked, apiKey);
  assert.equal(body.provider.credentialStatus, 'configured');
  assert.equal(body.provider.selected, true);
  assert.equal(body.provider.active, true);
  assert.notEqual(body.provider.runtimeStatus, 'missing_credentials');

  const listed = await request('/api/providers/credentials');
  assert.equal(listed.body.credentials.alphaVantage.configured, true);
  assert.notEqual(JSON.stringify(listed.body), apiKey);
});

test('provider health uses configured alphaVantage and never emits missing credential warning', async () => {
  const { body } = await request('/api/providers/health');
  const alpha = body.providers.find((provider) => provider.id === 'alphaVantage');
  assert.equal(alpha.credentialStatus, 'configured');
  assert.notEqual(alpha.runtimeStatus, 'missing_credentials');
  assert.equal(alpha.warnings.some((warning) => warning.includes('not configured')), false);
});

test('active providers yahoo only persists without re-adding fallback_demo', async () => {
  const save = await request('/api/providers/active', { method: 'POST', body: JSON.stringify({ providers: ['yahoo'], providerOrder: ['yahoo'] }) });
  assert.equal(save.response.status, 200);
  assert.deepEqual(save.body.activeProviders, ['yahoo']);
  assert.deepEqual(save.body.providerOrder, ['yahoo']);
  assert.equal(save.body.providers.find((provider) => provider.id === 'fallback_demo').active, false);
  assert.deepEqual(feedManager.getActiveProviders().providers, ['yahoo']);
});

test('active providers yahoo plus alphaVantage persists in order and feed status matches health', async () => {
  const save = await request('/api/providers/active', { method: 'POST', body: JSON.stringify({ providers: ['yahoo', 'alphaVantage'], providerOrder: ['yahoo', 'alphaVantage'] }) });
  assert.equal(save.response.status, 200);
  assert.deepEqual(save.body.activeProviders, ['yahoo', 'alphaVantage']);
  assert.deepEqual(save.body.providerOrder, ['yahoo', 'alphaVantage']);

  const health = await request('/api/providers/health');
  const feed = await request('/api/feed/status');
  assert.deepEqual(feed.body.activeProviders, health.body.activeProviders);
  assert.deepEqual(feed.body.providerOrder, health.body.providerOrder);
});

test('deleting alphaVantage credentials changes status to missing and selection without key is rejected', async () => {
  const deleted = await request('/api/providers/credentials/alphaVantage', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  const alpha = deleted.body.providers.find((provider) => provider.id === 'alphaVantage');
  assert.equal(alpha.credentialStatus, 'missing');

  const save = await request('/api/providers/active', { method: 'POST', body: JSON.stringify({ providers: ['alphaVantage'], providerOrder: ['alphaVantage'] }) });
  assert.equal(save.response.status, 400);
  assert.equal(save.body.error.code, 'missing_credentials');
});

test('environment alphaVantage key counts as configured', async () => {
  process.env.ALPHA_VANTAGE_API_KEY = 'ENVKEY12345678';
  const { body } = await request('/api/providers/health');
  const alpha = body.providers.find((provider) => provider.id === 'alphaVantage');
  assert.equal(alpha.credentialStatus, 'configured');
  assert.notEqual(alpha.runtimeStatus, 'missing_credentials');
  delete process.env.ALPHA_VANTAGE_API_KEY;
});

test('unknown provider is rejected', async () => {
  const save = await request('/api/providers/active', { method: 'POST', body: JSON.stringify({ providers: ['does_not_exist'], providerOrder: ['does_not_exist'] }) });
  assert.equal(save.response.status, 400);
  assert.equal(save.body.error.code, 'unknown_provider');
});


test('empty provider selection is rejected with structured validation error', async () => {
  const save = await request('/api/providers/active', { method: 'POST', body: JSON.stringify({ providers: [], providerOrder: [] }) });
  assert.equal(save.response.status, 400);
  assert.equal(save.body.success, false);
  assert.equal(save.body.error.code, 'NO_PROVIDER_SELECTED');
  assert.equal(save.body.error.message, 'Select at least one provider.');
});

test('stale fallback_demo enabled flag cannot override explicit yahoo saved selection', () => {
  const resolved = feedManager.resolveActiveState({
    providers: ['yahoo'],
    enabledByProvider: { yahoo: true, fallback_demo: true },
    symbols: [],
  });
  assert.deepEqual(resolved.providers, ['yahoo']);
  assert.equal(resolved.enabledByProvider.yahoo, true);
  assert.equal(resolved.enabledByProvider.fallback_demo, false);
});

test('yahoo delayed source reports delayed status instead of connection failure', async () => {
  await request('/api/providers/active', { method: 'POST', body: JSON.stringify({ providers: ['yahoo'], providerOrder: ['yahoo'] }) });
  feedManager.promoteProviderActivity({
    source: 'yahoo',
    symbol: 'SPY',
    timeframe: '1m',
    candles: [{ open: 500, high: 501, low: 499, close: 500.5, volume: 1000, timestamp: new Date().toISOString() }],
  });
  const health = await request('/api/providers/health');
  const yahoo = health.body.providers.find((provider) => provider.id === 'yahoo');
  const fallbackDemo = health.body.providers.find((provider) => provider.id === 'fallback_demo');
  assert.equal(yahoo.active, true);
  assert.equal(yahoo.connected, false);
  assert.equal(yahoo.runtimeStatus, 'delayed');
  assert.equal(yahoo.sourceType, 'delayed');
  assert.equal(yahoo.warnings.includes('Yahoo is delayed data, not live institutional feed.'), true);
  assert.equal(fallbackDemo.active, false);
  assert.equal(fallbackDemo.warnings.includes('Demo fallback source only. Not live market data.'), false);
});


test('mounted /api/providers/health returns canonical active providers even when stream diagnostics are mounted first', async () => {
  const { response, body } = await request('/api/providers/health');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.providers));
  assert.ok(Array.isArray(body.activeProviders));
  assert.ok(Array.isArray(body.providerOrder));
  assert.ok(body.streamProviders && typeof body.streamProviders === 'object');
  assert.ok(body.providers.every((provider) => Object.hasOwn(provider, 'credentialStatus')));
});
