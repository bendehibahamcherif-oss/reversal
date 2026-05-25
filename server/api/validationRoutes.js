import { Router } from 'express';
import { strategyValidationEngine } from '../validation/validationEngine.js';

const validationRoutes = Router();

validationRoutes.post('/strategy/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const { strategyId } = req.body || {};
  const result = strategyId
    ? strategyValidationEngine.validateStrategy(symbol, strategyId)
    : strategyValidationEngine.validateLatestStrategy(symbol);
  return res.json({ ok: true, symbol, result });
});

validationRoutes.get('/results/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ ok: true, symbol, results: strategyValidationEngine.getValidationResults(symbol) });
});

validationRoutes.get('/results/:symbol/:id', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  return res.json({ ok: true, symbol, result: strategyValidationEngine.getValidationResultById(symbol, req.params.id) });
});

validationRoutes.delete('/results/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  strategyValidationEngine.clearValidationResults(symbol);
  return res.json({ ok: true, symbol, results: [] });
});

export default validationRoutes;
