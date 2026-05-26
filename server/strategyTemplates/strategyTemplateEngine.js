import { createStrategyTemplate } from './strategyTemplate.js';
import { ruleEngine } from '../ruleEngine/ruleEngine.js';

const TEMPLATE_LIBRARY = [
  createStrategyTemplate({
    id: 'opening-gap-contrarian-reversal',
    name: 'Opening Gap Contrarian Reversal',
    description: 'Research template that drafts a contrarian reversal rule set after an opening gap. Draft/research use only; not auto-validated and no profitability claim.',
    category: 'contrarian',
    defaultSymbol: 'SPY',
    defaultTimeframe: '5m',
    conditions: [
      { source: 'quantFeature', field: 'openingGap.percent', operator: '>=', value: 0.75, timeframe: '5m', enabled: true },
      { source: 'quantFeature', field: 'openingGap.direction', operator: 'exists', timeframe: '5m', enabled: true },
      { source: 'quantFeature', field: 'session.minutesSinceOpen', operator: '>=', value: 15, timeframe: '5m', enabled: true },
      { source: 'quantFeature', field: 'vwap_distance', operator: 'exists', timeframe: '5m', enabled: true },
      { source: 'alpha', field: 'direction', operator: 'exists', timeframe: '5m', enabled: true },
      { source: 'qualityScore', field: 'score', operator: '>=', value: 50, timeframe: '5m', enabled: true },
    ],
    actions: [
      {
        type: 'reversal_entry',
        direction: 'derived_from_gap_direction',
        biasLogic: 'Gap up -> short bias; gap down -> long bias.',
        entryLogic: 'Wait for reversal confirmation after opening gap before entry.',
        exitLogic: 'Exit at VWAP, previous close, stop-loss, or invalidation condition.',
        stopLossLogic: 'For short bias place stop above session high; for long bias place stop below session low.',
        takeProfitLogic: 'Take profit at VWAP, previous close, or 2R.',
        invalidationCondition: 'Continuation in gap direction with volume expansion invalidates setup.',
      },
    ],
    riskRules: {
      maxRiskPerTrade: '1%',
      maxHoldingPeriod: 'intraday',
      noOvernightHold: true,
    },
    tags: ['template', 'contrarian', 'opening-gap', 'research_only'],
    warnings: [
      'Template output is draft/research only and must be manually reviewed.',
      'No profitability claim is made by this template.',
      'Template rule sets are not auto-validated.',
    ],
  }),
];

class StrategyTemplateEngine {
  constructor() {
    this.templates = TEMPLATE_LIBRARY;
  }

  listTemplates() { return this.templates; }

  getTemplate(id) {
    return this.templates.find((template) => template.id === String(id || '')) || null;
  }

  instantiateTemplate(id, overrides = {}) {
    const template = this.getTemplate(id);
    if (!template) return null;
    return {
      ...template,
      ...overrides,
      id: template.id,
      name: overrides.name || template.name,
      conditions: Array.isArray(overrides.conditions) ? overrides.conditions : template.conditions,
      actions: Array.isArray(overrides.actions) ? overrides.actions : template.actions,
      riskRules: overrides.riskRules && typeof overrides.riskRules === 'object' ? overrides.riskRules : template.riskRules,
      tags: Array.isArray(overrides.tags) ? overrides.tags : template.tags,
      warnings: Array.isArray(overrides.warnings) ? overrides.warnings : template.warnings,
      createdAt: template.createdAt,
    };
  }

  async createRuleSetFromTemplate(id, symbol, overrides = {}) {
    const instantiated = this.instantiateTemplate(id, overrides);
    if (!instantiated) return null;

    const finalSymbol = String(symbol || overrides.symbol || instantiated.defaultSymbol || '').toUpperCase();
    const timeframe = String(overrides.timeframe || instantiated.defaultTimeframe);

    return ruleEngine.createRuleSet({
      symbol: finalSymbol,
      name: overrides.ruleSetName || `${instantiated.name} (Template Draft)`,
      description: overrides.description || `${instantiated.description} Generated from strategy template for research workflow only.`,
      timeframe,
      conditions: instantiated.conditions,
      actions: instantiated.actions,
      riskRules: { ...instantiated.riskRules, ...(overrides.riskRules || {}) },
      tags: [...instantiated.tags, 'generated_template_rule_set'],
      status: 'draft',
    });
  }
}

export const strategyTemplateEngine = new StrategyTemplateEngine();
