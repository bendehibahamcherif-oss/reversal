import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const feedRoutes = Router();

// ── Status ─────────────────────────────────────────────────────────────────

feedRoutes.get('/status', (_req, res) => {
  return res.json(feedManager.getFeedStatusPayload());
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
  const body = req.body || {};
  if (Array.isArray(body.providers) && body.providers.length === 0 && !body.allowEmpty) {
    return res.status(400).json({ ok: false, success: false, error: { code: 'NO_PROVIDER_SELECTED', message: 'Select at least one provider.' } });
  }
  const result = feedManager.saveActiveProviders(body);
  if (!result.ok) {
    return res.status(result.status || 400).json({ success: false, error: result.error });
  }
  return res.json({ ok: true, success: true, activeProviders: result.activeProviders, providerOrder: result.providerOrder, providers: result.providers, source: result.source, warnings: result.warnings });
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
  const live = req.query?.live === '1';
  const tick = live ? await feedManager.getLatestTick(req.params.symbol) : feedManager.getCachedTick(req.params.symbol);
  return res.json({ success: true, ok: true, status: tick ? 'available' : 'unavailable', mode: tick ? 'cached' : 'rest_fallback', reason: tick ? undefined : 'No cached tick is available; pass live=1 to request provider polling.', ...(tick || {}), _raw: tick });
});

feedRoutes.get('/candle/:symbol', async (req, res) => {
  const timeframe = req.query?.timeframe || '1m';
  const live = req.query?.live === '1';
  const candle = live ? await feedManager.getLatestCandle(req.params.symbol, timeframe) : feedManager.getCachedCandle(req.params.symbol, timeframe);
  return res.json({ success: true, ok: true, status: candle ? 'available' : 'unavailable', mode: candle ? 'cached' : 'rest_fallback', reason: candle ? undefined : 'No cached candle is available; pass live=1 to request provider polling.', ...(candle || {}), _raw: candle });
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
