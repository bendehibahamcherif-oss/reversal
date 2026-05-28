import { Router } from 'express';
import { marketStreamEngine } from '../marketStream/MarketStreamEngine.js';
import { feedManager } from '../feeds/feedManager.js';

const marketStreamRoutes = Router();

// GET /api/providers/health
// Extended provider health: MarketStreamEngine adapter states + feedManager yahoo health
marketStreamRoutes.get('/providers/health', (_req, res) => {
  const streamHealth = marketStreamEngine.getProviderHealth();
  const yahooHealth = feedManager.getProviderHealth('yahoo');
  return res.json({
    success: true,
    providers: streamHealth,
    yahooHealth,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/market/runtime
// Full MarketStreamEngine runtime diagnostics
marketStreamRoutes.get('/market/runtime', (_req, res) => {
  return res.json({ success: true, ...marketStreamEngine.getDiagnostics() });
});

// GET /api/market/subscriptions
// Active symbol subscriptions with provider + stale status
marketStreamRoutes.get('/market/subscriptions', (_req, res) => {
  const subs = marketStreamEngine.getSubscriptions();
  return res.json({
    success: true,
    subscriptions: subs,
    count: Object.keys(subs).length,
    timestamp: new Date().toISOString(),
  });
});

// POST /api/market/subscribe — subscribe to a symbol stream
marketStreamRoutes.post('/market/subscribe', async (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });
  try {
    const sub = await marketStreamEngine.subscribe(String(symbol).toUpperCase());
    return res.json({ success: true, subscription: sub });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

// DELETE /api/market/subscribe/:symbol — unsubscribe a symbol
marketStreamRoutes.delete('/market/subscribe/:symbol', async (req, res) => {
  try {
    await marketStreamEngine.unsubscribe(req.params.symbol);
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

export default marketStreamRoutes;
