import { Router } from 'express';
import { ruleEngine } from '../ruleEngine/ruleEngine.js';

const ruleEngineRoutes = Router();

ruleEngineRoutes.get('/sets/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const ruleSets = await ruleEngine.getRuleSets(symbol);
  return res.json({ ok: true, symbol, ruleSets });
});

ruleEngineRoutes.get('/set/:id', async (req, res) => {
  const ruleSet = await ruleEngine.getRuleSetById(req.params.id);
  if (!ruleSet) return res.status(404).json({ ok: false, error: 'Rule set not found' });
  return res.json({ ok: true, ruleSet });
});

ruleEngineRoutes.post('/set/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const ruleSet = await ruleEngine.createRuleSet({ ...(req.body || {}), symbol });
  return res.json({ ok: true, symbol, ruleSet });
});

ruleEngineRoutes.put('/set/:id', async (req, res) => {
  const ruleSet = await ruleEngine.updateRuleSet(req.params.id, req.body || {});
  if (!ruleSet) return res.status(404).json({ ok: false, error: 'Rule set not found' });
  return res.json({ ok: true, ruleSet });
});

ruleEngineRoutes.delete('/set/:id', async (req, res) => {
  const result = await ruleEngine.deleteRuleSet(req.params.id);
  return res.json({ ok: true, ...result });
});

ruleEngineRoutes.delete('/sets/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = await ruleEngine.clearRuleSets(symbol);
  return res.json({ ok: true, symbol, ...result });
});

ruleEngineRoutes.post('/evaluate/:symbol/:id', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = await ruleEngine.evaluateRuleSet(symbol, req.params.id);
  if (!result) return res.status(404).json({ ok: false, error: 'Rule set not found' });
  return res.json({ ok: true, ...result });
});

ruleEngineRoutes.post('/convert/:symbol/:id', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const strategy = await ruleEngine.convertRuleSetToStrategy(symbol, req.params.id);
  if (!strategy) return res.status(404).json({ ok: false, error: 'Rule set not found' });
  return res.json({ ok: true, symbol, strategy });
});

export default ruleEngineRoutes;
