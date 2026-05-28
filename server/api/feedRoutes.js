import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const feedRoutes = Router();
feedRoutes.get('/status', (_req, res) => {
  const statuses = feedManager.getFeedStatus();
  const active = feedManager.getActiveProviders();
  return res.json({ success: true, activeProviders: active.providers, providerOrder: active.providerOrder, source: active.providers[0] || 'fallback_demo', connected: statuses.some((s) => s.connected === true), warnings: [], statuses, providers: statuses });
});
feedRoutes.get('/status/:source', (req, res) => res.json({ success: true, feed: feedManager.getFeedStatusBySource(req.params.source) }));
feedRoutes.post('/start', (req, res) => res.json({ success: true, feed: feedManager.startFeed(req.body?.source, req.body?.symbols) }));
feedRoutes.post('/stop', (req, res) => res.json({ success: true, feed: feedManager.stopFeed(req.body?.source) }));
feedRoutes.get('/providers', (_req, res) => res.json({ success: true, providers: feedManager.listProviders() }));
feedRoutes.get('/providers/active', (_req, res) => res.json({ success: true, ...feedManager.getActiveProviders() }));
feedRoutes.post('/providers/active', (req, res) => res.json({ success: true, ...feedManager.setActiveProviders(req.body || {}) }));
feedRoutes.get('/providers/:provider', (req, res) => { const provider = feedManager.getProvider(req.params.provider); if (!provider) return res.status(404).json({ success: false, error: 'provider_not_found' }); return res.json({ success: true, provider }); });
feedRoutes.post('/providers/:provider/credentials', (req, res) => { const meta = feedManager.setProviderCredentials(req.params.provider, req.body || {}); if (!meta) return res.status(404).json({ success: false, error: 'provider_not_found' }); return res.json({ success: true, credentials: meta }); });
feedRoutes.delete('/providers/:provider/credentials', (req, res) => { const meta = feedManager.clearProviderCredentials(req.params.provider); if (!meta) return res.status(404).json({ success: false, error: 'provider_not_found' }); return res.json({ success: true, credentials: meta }); });
feedRoutes.get('/tick/:symbol', async (req, res) => { const tick = await feedManager.getLatestTick(req.params.symbol); return res.json({ success: true, ...(tick || {}), _raw: tick }); });
feedRoutes.get('/candle/:symbol', async (req, res) => { const candle = await feedManager.getLatestCandle(req.params.symbol, req.query?.timeframe || '1m'); return res.json({ success: true, ...(candle || {}), _raw: candle }); });
feedRoutes.get('/orderbook/:symbol', (req, res) => { const ob = feedManager.getLatestOrderBook(req.params.symbol); return res.json({ success: true, ...(ob || {}), _raw: ob }); });
feedRoutes.get('/debug/yahoo/:symbol', async (req, res) => {
  const result = await feedManager.debugYahoo(req.params.symbol, req.query?.timeframe || '1m');
  const status = result?.request?.success ? 200 : 502;
  return res.status(status).json({ success: result?.request?.success, ...result });
});
feedRoutes.post('/demo/tick/:symbol', (req, res) => res.json({ success: true, tick: feedManager.generateDemoTick(req.params.symbol) }));
feedRoutes.post('/demo/candle/:symbol', (req, res) => res.json({ success: true, candle: feedManager.generateDemoCandle(req.params.symbol, req.query?.timeframe || req.body?.timeframe || '1m') }));
feedRoutes.post('/demo/orderbook/:symbol', (req, res) => res.json({ success: true, orderbook: feedManager.generateDemoOrderBook(req.params.symbol) }));

export default feedRoutes;
