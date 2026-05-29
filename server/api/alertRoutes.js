import { Router } from 'express';
import { alertStore } from '../alerts/AlertStore.js';
import { alertHistoryStore } from '../alerts/AlertHistoryStore.js';
import { alertEngine } from '../alerts/AlertEngine.js';

const router = Router();

// GET /api/alerts?symbol=SPY
router.get('/', (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const alerts = alertStore.getAll(symbol);
    return res.json({ success: true, alerts, count: alerts.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/alerts
router.post('/', (req, res) => {
  try {
    const { symbol, type, threshold, params, cooldownMode, cooldownMinutes, expiresAt } = req.body || {};
    const alert = alertStore.create({ symbol, type, threshold, params, cooldownMode, cooldownMinutes, expiresAt });
    return res.json({ success: true, alert });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

// GET /api/alerts/diagnostics  — must be before /:id
router.get('/diagnostics', (_req, res) => {
  return res.json({ success: true, ...alertEngine.getDiagnostics() });
});

// GET /api/alerts/history?alertId=&limit=  — must be before /:id
router.get('/history', (req, res) => {
  try {
    const alertId = req.query.alertId || null;
    const limit   = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const history = alertId
      ? alertHistoryStore.getByAlert(alertId, limit)
      : alertHistoryStore.getAll(limit);
    return res.json({ success: true, history, count: history.length });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/alerts/:id
router.get('/:id', (req, res) => {
  const alert = alertStore.get(req.params.id);
  if (!alert) return res.status(404).json({ success: false, error: 'alert not found' });
  return res.json({ success: true, alert });
});

// PUT /api/alerts/:id
router.put('/:id', (req, res) => {
  try {
    const updated = alertStore.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ success: false, error: 'alert not found' });
    return res.json({ success: true, alert: updated });
  } catch (e) {
    return res.status(400).json({ success: false, error: e.message });
  }
});

// DELETE /api/alerts/:id
router.delete('/:id', (req, res) => {
  const deleted = alertStore.delete(req.params.id);
  if (!deleted) return res.status(404).json({ success: false, error: 'alert not found' });
  return res.json({ success: true });
});

// POST /api/alerts/:id/enable
router.post('/:id/enable', (req, res) => {
  const updated = alertStore.update(req.params.id, { enabled: true });
  if (!updated) return res.status(404).json({ success: false, error: 'alert not found' });
  return res.json({ success: true, alert: updated });
});

// POST /api/alerts/:id/disable
router.post('/:id/disable', (req, res) => {
  const updated = alertStore.update(req.params.id, { enabled: false });
  if (!updated) return res.status(404).json({ success: false, error: 'alert not found' });
  return res.json({ success: true, alert: updated });
});

export default router;
