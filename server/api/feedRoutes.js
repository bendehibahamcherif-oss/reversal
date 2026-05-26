import { Router } from 'express';
import { feedManager } from '../feeds/feedManager.js';

const feedRoutes = Router();
feedRoutes.get('/status', (_req, res) => res.json({ success: true, feeds: feedManager.getFeedStatus() }));
feedRoutes.get('/status/:source', (req, res) => res.json({ success: true, feed: feedManager.getFeedStatusBySource(req.params.source) }));
feedRoutes.post('/start', (req, res) => res.json({ success: true, feed: feedManager.startFeed(req.body?.source, req.body?.symbols) }));
feedRoutes.post('/stop', (req, res) => res.json({ success: true, feed: feedManager.stopFeed(req.body?.source) }));
feedRoutes.get('/providers', (_req, res) => res.json({ success: true, providers: feedManager.listProviders() }));
feedRoutes.get('/providers/active', (_req, res) => res.json({ success: true, active: feedManager.getActiveProviders() }));
feedRoutes.post('/providers/active', (req, res) => res.json({ success: true, active: feedManager.setActiveProviders(req.body || {}) }));
feedRoutes.get('/providers/:provider', (req, res) => { const provider = feedManager.getProvider(req.params.provider); if (!provider) return res.status(404).json({ success: false, error: 'provider_not_found' }); return res.json({ success: true, provider }); });
feedRoutes.post('/providers/:provider/credentials', (req, res) => { const meta = feedManager.setProviderCredentials(req.params.provider, req.body || {}); if (!meta) return res.status(404).json({ success: false, error: 'provider_not_found' }); return res.json({ success: true, credentials: meta }); });
feedRoutes.delete('/providers/:provider/credentials', (req, res) => { const meta = feedManager.clearProviderCredentials(req.params.provider); if (!meta) return res.status(404).json({ success: false, error: 'provider_not_found' }); return res.json({ success: true, credentials: meta }); });
feedRoutes.get('/tick/:symbol', (req, res) => res.json({ success: true, tick: feedManager.getLatestTick(req.params.symbol) }));
feedRoutes.get('/candle/:symbol', (req, res) => res.json({ success: true, candle: feedManager.getLatestCandle(req.params.symbol, req.query?.timeframe || '1m') }));
feedRoutes.get('/orderbook/:symbol', (req, res) => res.json({ success: true, orderbook: feedManager.getLatestOrderBook(req.params.symbol) }));
feedRoutes.post('/demo/tick/:symbol', (req, res) => res.json({ success: true, tick: feedManager.generateDemoTick(req.params.symbol) }));
feedRoutes.post('/demo/candle/:symbol', (req, res) => res.json({ success: true, candle: feedManager.generateDemoCandle(req.params.symbol, req.query?.timeframe || req.body?.timeframe || '1m') }));
feedRoutes.post('/demo/orderbook/:symbol', (req, res) => res.json({ success: true, orderbook: feedManager.generateDemoOrderBook(req.params.symbol) }));

export default feedRoutes;
