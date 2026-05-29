import { Router } from 'express';
import { ruleEngine } from '../ruleEngine/ruleEngine.js';
import { validationEngine, LEGAL_DISCLAIMER } from '../ruleEngine/validationEngine.js';
import { backtestEngine } from '../backtest/backtestEngine.js';

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

// POST /api/rules/validate/:id  — inline validation with field-level warnings + AND/OR group support
ruleEngineRoutes.post('/validate/:id', async (req, res) => {
  const ruleSet = await ruleEngine.getRuleSetById(req.params.id);
  if (!ruleSet) return res.status(404).json({ ok: false, error: 'Rule set not found' });
  // Allow the caller to overlay conditionGroups / disclaimerAccepted without persisting
  const merged = { ...ruleSet, ...(req.body || {}) };
  const result = validationEngine.validate(merged);
  return res.json({ ok: true, id: ruleSet.id, ...result, disclaimer: LEGAL_DISCLAIMER });
});

// POST /api/rules/preview/:symbol/:id — live preview backtest (non-bypassable disclaimer gate)
ruleEngineRoutes.post('/preview/:symbol/:id', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const body = req.body || {};

  if (body.disclaimerAccepted !== true) {
    return res.status(403).json({
      ok: false,
      error: 'Legal disclaimer must be accepted before running a preview backtest.',
      disclaimer: LEGAL_DISCLAIMER,
      field: 'disclaimerAccepted',
    });
  }

  const ruleSet = await ruleEngine.getRuleSetById(req.params.id);
  if (!ruleSet) return res.status(404).json({ ok: false, error: 'Rule set not found' });

  const direction = ruleSet.actions?.[0]?.direction;
  const safeDirection = direction === 'short' ? 'short' : 'long';

  const candidate = {
    id: ruleSet.id,
    name: ruleSet.name,
    symbol,
    direction: safeDirection,
    status: 'research_only',
    warnings: [
      'Preview backtest uses a research-only rule set candidate; not a validation of live profitability.',
      ...(Array.isArray(ruleSet.tags) && ruleSet.tags.includes('generated_template_rule_set')
        ? ['Generated from template; review all conditions before any live use.']
        : []),
    ],
  };

  const timeframe = String(body.timeframe || ruleSet.timeframe || '1m');
  const result = backtestEngine.runBacktestFromCandidate(symbol, candidate, timeframe);
  return res.json({ ok: true, symbol, ruleSetId: ruleSet.id, preview: true, disclaimer: LEGAL_DISCLAIMER, result });
});

export default ruleEngineRoutes;
