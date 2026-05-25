import { Router } from 'express';
import { strategyLabEngine } from '../strategyLab/strategyLabEngine.js';

const strategyLabRoutes = Router();

strategyLabRoutes.get('/strategies/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ success: true, symbol, strategies: strategyLabEngine.listStrategies(symbol) });
});

strategyLabRoutes.get('/strategy/:id', (req, res) => {
  const strategy = strategyLabEngine.getStrategy(req.params.id);
  if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
  return res.json({ success: true, strategy });
});

strategyLabRoutes.post('/save/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const strategy = strategyLabEngine.save(symbol, req.body || {});
    return res.json({ success: true, symbol, strategy });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

strategyLabRoutes.put('/strategy/:id', (req, res) => {
  const strategy = strategyLabEngine.update(req.params.id, req.body || {});
  if (!strategy) return res.status(404).json({ success: false, error: 'Strategy not found' });
  return res.json({ success: true, strategy });
});

strategyLabRoutes.delete('/strategy/:id', (req, res) => {
  const removed = strategyLabEngine.delete(req.params.id);
  return res.json({ success: true, removed });
});

strategyLabRoutes.delete('/strategies/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ success: true, symbol, strategies: strategyLabEngine.clear(symbol) });
});

strategyLabRoutes.post('/compare/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json(strategyLabEngine.compare(symbol, req.body || {}));
});

export default strategyLabRoutes;
