import { Router } from 'express';
import { executionEngine } from '../execution/executionEngine.js';
import { executionAnalytics } from '../execution/executionAnalytics.js';
import { enableGlobalKillSwitch, disableGlobalKillSwitch, getRiskStatus } from '../execution/riskChecker.js';

const executionRoutes = Router();

// ── System status ─────────────────────────────────────────────────────────────

// GET /api/execution/status — mode badge, flags, risk config
executionRoutes.get('/status', (_req, res) => {
  return res.json({ ok: true, ...executionEngine.getStatus() });
});

// GET /api/execution/risk — detailed risk config + kill switch state
executionRoutes.get('/risk', (_req, res) => {
  return res.json({ ok: true, ...getRiskStatus() });
});

// POST /api/execution/risk/kill-switch — enable kill switch
executionRoutes.post('/risk/kill-switch', (_req, res) => {
  enableGlobalKillSwitch();
  return res.json({ ok: true, killSwitch: true, mode: 'paper_locked', message: 'Kill switch enabled. All execution blocked.' });
});

// DELETE /api/execution/risk/kill-switch — disable kill switch
executionRoutes.delete('/risk/kill-switch', (_req, res) => {
  disableGlobalKillSwitch();
  return res.json({ ok: true, killSwitch: false, message: 'Kill switch disabled.' });
});

// ── Order management ──────────────────────────────────────────────────────────

// POST /api/execution/orders — place an order
// Body: { symbol, side, type?, quantity, requestedPrice?, mode?, clientOrderId?, strategyId? }
executionRoutes.post('/orders', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.symbol)   return res.status(400).json({ ok: false, error: 'symbol is required' });
    if (!body.side)     return res.status(400).json({ ok: false, error: 'side is required' });
    if (!body.quantity) return res.status(400).json({ ok: false, error: 'quantity is required' });

    const result = await executionEngine.placeOrder(body);
    const statusCode = result.ok ? 200 : (result.riskCode ? 422 : 500);
    return res.status(statusCode).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/execution/orders — list orders
// Query: symbol?, mode?, status?, limit?
executionRoutes.get('/orders', (req, res) => {
  try {
    const orders = executionEngine.getOrders({
      symbol: req.query.symbol,
      mode:   req.query.mode,
      status: req.query.status,
      limit:  req.query.limit,
    });
    return res.json({ ok: true, orders, count: orders.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/execution/orders/:orderId — single order
executionRoutes.get('/orders/:orderId', (req, res) => {
  const order = executionEngine.getOrderById(req.params.orderId);
  if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
  return res.json({ ok: true, order });
});

// DELETE /api/execution/orders/:orderId — cancel order
executionRoutes.delete('/orders/:orderId', async (req, res) => {
  try {
    const result = await executionEngine.cancelOrder(req.params.orderId);
    if (!result.ok) return res.status(422).json({ ok: false, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Fills ─────────────────────────────────────────────────────────────────────

// GET /api/execution/fills — all fills
// Query: symbol?, mode?, limit?
executionRoutes.get('/fills', (req, res) => {
  try {
    const fills = executionEngine.getFills({
      symbol: req.query.symbol,
      mode:   req.query.mode,
      limit:  req.query.limit,
    });
    return res.json({ ok: true, fills, count: fills.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Execution analytics ───────────────────────────────────────────────────────

// GET /api/execution/analytics — execution quality metrics
// Query: symbol?, mode?, limit?
executionRoutes.get('/analytics', (req, res) => {
  try {
    const result = executionAnalytics.compute({
      symbol: req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined,
      mode:   req.query.mode,
      limit:  req.query.limit,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default executionRoutes;
