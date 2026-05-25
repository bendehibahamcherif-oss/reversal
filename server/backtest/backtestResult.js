let backtestResultCounter = 0;

export function createBacktestResult(input = {}) {
  backtestResultCounter += 1;
  const now = new Date().toISOString();

  return {
    id: input.id || `bt-result-${Date.now()}-${backtestResultCounter}`,
    symbol: String(input.symbol || '').toUpperCase(),
    strategyId: String(input.strategyId || ''),
    strategyName: String(input.strategyName || 'Unknown Strategy'),
    timeframe: String(input.timeframe || '1m'),
    trades: Array.isArray(input.trades) ? input.trades : [],
    metrics: input.metrics && typeof input.metrics === 'object' ? input.metrics : {},
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    createdAt: input.createdAt || now,
  };
}
