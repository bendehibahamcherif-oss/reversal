import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const feedRoutes = Router();

// ── Status ─────────────────────────────────────────────────────────────────

feedRoutes.get('/status', (_req, res) => {
  const statuses = feedManager.getFeedStatus();
  const active   = feedManager.getActiveProviders();
  const warnings = statuses.flatMap((s) => s.warnings || []).filter(Boolean);
  return res.json({
    ok:              true,
    success:         true,
    activeProviders: active.providers,
    providerOrder:   active.providerOrder,
    source:          active.providers[0] || 'fallback_demo',
    connected:       statuses.some((s) => s.connected === true),
    warnings,
    statuses,
    providers: statuses,
  });
});

feedRoutes.get('/status/:source', (req, res) => {
  const feed = feedManager.getFeedStatusBySource(req.params.source);
  return res.json({ success: true, feed });
});

// ── Start / Stop ────────────────────────────────────────────────────────────

feedRoutes.post('/start', (req, res) => {
  const feed = feedManager.startFeed(req.body?.source, req.body?.symbols);
  return res.json({ success: true, feed });
});

feedRoutes.post('/stop', (req, res) => {
  const feed = feedManager.stopFeed(req.body?.source);
  return res.json({ success: true, feed });
});

// ── Providers ───────────────────────────────────────────────────────────────

feedRoutes.get('/providers', (_req, res) => {
  return res.json({ success: true, providers: feedManager.listProviders() });
});

feedRoutes.get('/providers/active', (_req, res) => {
  const result = feedManager.getActiveProviders();
  return res.json({ ok: true, success: true, ...result, activeProviders: result.providers });
});

feedRoutes.post('/providers/active', (req, res) => {
  const result = feedManager.setActiveProviders(req.body || {});
  return res.json({ ok: true, success: true, ...result, activeProviders: result.providers });
});

feedRoutes.get('/providers/:provider', (req, res) => {
  const provider = feedManager.getProvider(req.params.provider);
  if (!provider) {
    return res.status(404).json({ success: false, error: 'provider_not_found' });
  }
  return res.json({ success: true, provider });
});

feedRoutes.post('/providers/:provider/credentials', (req, res) => {
  const meta = feedManager.setProviderCredentials(req.params.provider, req.body || {});
  if (!meta) {
    return res.status(404).json({ success: false, error: 'provider_not_found' });
  }
  return res.json({
    success: true,
    credentials: meta,
    credentialsStatus: meta.configured ? 'configured' : 'missing_credentials',
  });
});

feedRoutes.delete('/providers/:provider/credentials', (req, res) => {
  const meta = feedManager.clearProviderCredentials(req.params.provider);
  if (!meta) {
    return res.status(404).json({ success: false, error: 'provider_not_found' });
  }
  return res.json({ success: true, credentials: meta, credentialsStatus: 'missing_credentials' });
});

// ── Live data ────────────────────────────────────────────────────────────────

feedRoutes.get('/tick/:symbol', async (req, res) => {
  const tick = await feedManager.getLatestTick(req.params.symbol);
  return res.json({ success: true, ...(tick || {}), _raw: tick });
});

feedRoutes.get('/candle/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const candle    = await feedManager.getLatestCandle(req.params.symbol, timeframe);
  return res.json({ success: true, ...(candle || {}), _raw: candle });
});

feedRoutes.get('/orderbook/:symbol', (req, res) => {
  const ob = feedManager.getLatestOrderBook(req.params.symbol);
  return res.json({ success: true, ...(ob || {}), _raw: ob });
});

// ── Debug ────────────────────────────────────────────────────────────────────

feedRoutes.get('/debug/yahoo/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const result    = await feedManager.debugYahoo(req.params.symbol, timeframe);
  const status    = result?.request?.success ? 200 : 502;
  return res.status(status).json({ success: result?.request?.success, ...result });
});

// ── Demo ─────────────────────────────────────────────────────────────────────

feedRoutes.post('/demo/tick/:symbol', (req, res) => {
  const tick = feedManager.generateDemoTick(req.params.symbol);
  return res.json({ success: true, tick });
});

feedRoutes.post('/demo/candle/:symbol', (req, res) => {
  const timeframe = req.query?.timeframe || req.body?.timeframe || '1m';
  const candle    = feedManager.generateDemoCandle(req.params.symbol, timeframe);
  return res.json({ success: true, candle });
});

feedRoutes.post('/demo/orderbook/:symbol', (req, res) => {
  const orderbook = feedManager.generateDemoOrderBook(req.params.symbol);
  return res.json({ success: true, orderbook });
});

export default feedRoutes;
