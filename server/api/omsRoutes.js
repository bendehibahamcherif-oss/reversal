import { Router } from 'express';
import { omsEngine } from '../oms/omsEngine.js';

const omsRoutes = Router();

// ── Create order ───────────────────────────────────────────────────────────────

// POST /api/oms/orders
omsRoutes.post('/orders', (req, res) => {
  try {
    const body = req.body || {};
    if (!body.symbol)   return res.status(400).json({ ok: false, error: 'symbol is required' });
    if (!body.side)     return res.status(400).json({ ok: false, error: 'side is required' });
    if (!body.quantity) return res.status(400).json({ ok: false, error: 'quantity is required' });
    const result = omsEngine.createOrder(body);
    return res.status(result.idempotent ? 200 : 201).json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── List orders ────────────────────────────────────────────────────────────────

// GET /api/oms/orders?symbol=&mode=&status=&limit=
omsRoutes.get('/orders', (req, res) => {
  try {
    const orders = omsEngine.getOrders({
      symbol:        req.query.symbol,
      mode:          req.query.mode,
      status:        req.query.status,
      parentOrderId: req.query.parentOrderId,
      limit:         req.query.limit,
    });
    return res.json({ ok: true, orders, count: orders.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/oms/orders/open?mode=
omsRoutes.get('/orders/open', (req, res) => {
  try {
    const orders = omsEngine.getOpenOrders(req.query.mode);
    return res.json({ ok: true, orders, count: orders.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/oms/orders/:orderId
omsRoutes.get('/orders/:orderId', (req, res) => {
  try {
    const order = omsEngine.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, error: 'Order not found' });
    return res.json({ ok: true, order });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/oms/orders/:orderId/events
omsRoutes.get('/orders/:orderId/events', (req, res) => {
  try {
    const full = omsEngine.getOrderWithEvents(req.params.orderId);
    if (!full) return res.status(404).json({ ok: false, error: 'Order not found' });
    return res.json({ ok: true, order: full, events: full.events, count: full.events.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/oms/orders/:orderId/children
omsRoutes.get('/orders/:orderId/children', (req, res) => {
  try {
    const children = omsEngine.getChildren(req.params.orderId);
    return res.json({ ok: true, children, count: children.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Order lifecycle transitions ────────────────────────────────────────────────

// POST /api/oms/orders/:orderId/submit
omsRoutes.post('/orders/:orderId/submit', (req, res) => {
  try {
    const result = omsEngine.submit(req.params.orderId, req.body || {});
    if (!result.ok) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/oms/orders/:orderId/acknowledge
omsRoutes.post('/orders/:orderId/acknowledge', (req, res) => {
  try {
    const result = omsEngine.acknowledge(req.params.orderId, req.body || {});
    if (!result.ok) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/oms/orders/:orderId/fill
// Body: { fillQuantity, fillPrice, commissions?, slippageBps?, brokerOrderId?, brokerTimestamp? }
omsRoutes.post('/orders/:orderId/fill', (req, res) => {
  try {
    const body = req.body || {};
    if (body.fillQuantity == null) return res.status(400).json({ ok: false, error: 'fillQuantity is required' });
    if (body.fillPrice    == null) return res.status(400).json({ ok: false, error: 'fillPrice is required' });
    const result = omsEngine.fill(req.params.orderId, body);
    if (!result.ok) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /api/oms/orders/:orderId — cancel
omsRoutes.delete('/orders/:orderId', (req, res) => {
  try {
    const result = omsEngine.cancel(req.params.orderId, { reason: req.body?.reason });
    if (!result.ok) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/oms/orders/:orderId/reject
omsRoutes.post('/orders/:orderId/reject', (req, res) => {
  try {
    const result = omsEngine.reject(req.params.orderId, req.body || {});
    if (!result.ok) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/oms/orders/:orderId/expire
omsRoutes.post('/orders/:orderId/expire', (req, res) => {
  try {
    const result = omsEngine.expire(req.params.orderId);
    if (!result.ok) return res.status(422).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Reconciliation ─────────────────────────────────────────────────────────────

// POST /api/oms/reconcile?mode=paper|live
omsRoutes.post('/reconcile', async (req, res) => {
  try {
    const mode = (req.query.mode || req.body?.mode || 'paper');
    const result = await omsEngine.reconcile(mode);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/oms/reconcile/runs?limit=
omsRoutes.get('/reconcile/runs', (req, res) => {
  try {
    const runs = omsEngine.getReconciliationRuns(Number(req.query.limit) || 20);
    return res.json({ ok: true, runs, count: runs.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Events ─────────────────────────────────────────────────────────────────────

// GET /api/oms/events?limit=
omsRoutes.get('/events', (req, res) => {
  try {
    const events = omsEngine.getRecentEvents(Number(req.query.limit) || 50);
    return res.json({ ok: true, events, count: events.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Stats ──────────────────────────────────────────────────────────────────────

// GET /api/oms/stats?mode=
omsRoutes.get('/stats', (req, res) => {
  try {
    const stats = omsEngine.getStats(req.query.mode);
    return res.json({ ok: true, ...stats });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default omsRoutes;
