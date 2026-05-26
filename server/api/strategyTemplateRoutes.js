import { Router } from 'express';
import { strategyTemplateEngine } from '../strategyTemplates/strategyTemplateEngine.js';

const strategyTemplateRoutes = Router();

strategyTemplateRoutes.get('/strategies', (req, res) => {
  const templates = strategyTemplateEngine.listTemplates();
  return res.json({ ok: true, templates });
});

strategyTemplateRoutes.get('/strategies/:id', (req, res) => {
  const template = strategyTemplateEngine.getTemplate(req.params.id);
  if (!template) return res.status(404).json({ ok: false, error: 'Strategy template not found' });
  return res.json({ ok: true, template });
});

strategyTemplateRoutes.post('/strategies/:id/create-rule-set', async (req, res) => {
  const body = req.body || {};
  const ruleSet = await strategyTemplateEngine.createRuleSetFromTemplate(req.params.id, body.symbol, body.overrides || body);
  if (!ruleSet) return res.status(404).json({ ok: false, error: 'Strategy template not found' });
  return res.json({ ok: true, templateId: req.params.id, ruleSet, note: 'Created as draft/research rule set only. Not auto-validated.' });
});

export default strategyTemplateRoutes;
