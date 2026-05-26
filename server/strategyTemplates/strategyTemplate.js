export function createStrategyTemplate(input = {}) {
  return {
    id: String(input.id || ''),
    name: String(input.name || ''),
    description: String(input.description || ''),
    category: String(input.category || 'research'),
    defaultSymbol: String(input.defaultSymbol || 'SPY').toUpperCase(),
    defaultTimeframe: String(input.defaultTimeframe || '5m'),
    conditions: Array.isArray(input.conditions) ? input.conditions.map((item) => ({ ...item })) : [],
    actions: Array.isArray(input.actions) ? input.actions.map((item) => ({ ...item })) : [],
    riskRules: input.riskRules && typeof input.riskRules === 'object' ? { ...input.riskRules } : {},
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [],
    warnings: Array.isArray(input.warnings) ? input.warnings.map((warning) => String(warning)) : [],
    createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : new Date().toISOString(),
  };
}
