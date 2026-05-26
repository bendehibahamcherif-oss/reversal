import { randomUUID } from 'node:crypto';

const ALLOWED_OPERATORS = new Set(['>', '>=', '<', '<=', '==', '!=', 'contains', 'exists']);
const ALLOWED_SOURCES = new Set(['alpha', 'pattern', 'quantFeature', 'qualityScore', 'analytics', 'backtest', 'strategy', 'sessionContext']);

export function createRuleCondition(input = {}) {
  const operator = String(input.operator || 'exists');
  const source = String(input.source || 'strategy');
  return {
    id: String(input.id || randomUUID()),
    field: String(input.field || ''),
    operator: ALLOWED_OPERATORS.has(operator) ? operator : 'exists',
    value: input.value,
    source: ALLOWED_SOURCES.has(source) ? source : 'strategy',
    timeframe: String(input.timeframe || '1m'),
    enabled: input.enabled !== false,
  };
}
