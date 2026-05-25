let backtestTradeCounter = 0;

export function createBacktestTrade(input = {}) {
  backtestTradeCounter += 1;
  const now = new Date().toISOString();

  return {
    id: input.id || `bt-trade-${Date.now()}-${backtestTradeCounter}`,
    symbol: String(input.symbol || '').toUpperCase(),
    strategyId: String(input.strategyId || ''),
    direction: input.direction === 'short' ? 'short' : 'long',
    entryTime: input.entryTime || null,
    entryPrice: Number(input.entryPrice) || 0,
    exitTime: input.exitTime || null,
    exitPrice: Number(input.exitPrice) || 0,
    quantity: Number(input.quantity) || 0,
    pnl: Number(input.pnl) || 0,
    pnlPercent: Number(input.pnlPercent) || 0,
    reason: String(input.reason || 'unknown'),
    createdAt: input.createdAt || now,
  };
}
