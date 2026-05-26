import { randomUUID } from 'node:crypto';
import { createRuleCondition } from './ruleCondition.js';
import { createRuleAction } from './ruleAction.js';

const ALLOWED_STATUS = new Set(['draft', 'research_only', 'archived']);

export function createStrategyRuleSet(input = {}) {
  const now = new Date().toISOString();
  const status = String(input.status || 'draft');

  return {
    id: String(input.id || randomUUID()),
    symbol: String(input.symbol || '').toUpperCase(),
    name: String(input.name || 'Unnamed Rule Set'),
    description: String(input.description || ''),
    timeframe: String(input.timeframe || '1m'),
    conditions: Array.isArray(input.conditions) ? input.conditions.map((item) => createRuleCondition(item)) : [],
    actions: Array.isArray(input.actions) ? input.actions.map((item) => createRuleAction(item)) : [],
    riskRules: input.riskRules && typeof input.riskRules === 'object' ? input.riskRules : {},
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [],
    status: ALLOWED_STATUS.has(status) ? status : 'draft',
    createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : now,
    updatedAt: input.updatedAt ? new Date(input.updatedAt).toISOString() : now,
  };
}
