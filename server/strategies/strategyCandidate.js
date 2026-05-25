let strategyCounter = 0;

export function createStrategyCandidate(input = {}) {
  strategyCounter += 1;
  const now = new Date().toISOString();

  return {
    id: `strat-${Date.now()}-${strategyCounter}`,
    symbol: String(input.symbol || '').toUpperCase(),
    name: String(input.name || 'Unnamed Strategy'),
    type: String(input.type || 'signal-alignment'),
    direction: ['long', 'short', 'neutral'].includes(input.direction) ? input.direction : 'neutral',
    confidence: Math.max(0, Math.min(0.99, Number(input.confidence) || 0)),
    timeframe: String(input.timeframe || '1m'),
    entryLogic: String(input.entryLogic || ''),
    exitLogic: String(input.exitLogic || ''),
    riskRules: input.riskRules && typeof input.riskRules === 'object' ? input.riskRules : {},
    supportingSignals: Array.isArray(input.supportingSignals) ? input.supportingSignals : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    createdAt: input.createdAt || now,
  };
}
