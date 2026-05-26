export function createPaperOrder(input = {}) {
  return {
    id: String(input.id || ''), symbol: String(input.symbol || '').toUpperCase(), side: String(input.side || 'buy').toLowerCase(), type: String(input.type || 'market').toLowerCase(), quantity: Number(input.quantity || 0), requestedPrice: input.requestedPrice == null ? null : Number(input.requestedPrice), status: String(input.status || 'pending').toLowerCase(), createdAt: input.createdAt || new Date().toISOString(), filledAt: input.filledAt || null, fillPrice: input.fillPrice == null ? null : Number(input.fillPrice), strategyId: input.strategyId == null ? null : String(input.strategyId), source: String(input.source || 'paper').toLowerCase(),
  };
}
export function createPaperFill(input = {}) {
  return {
    id: String(input.id || ''), orderId: String(input.orderId || ''), symbol: String(input.symbol || '').toUpperCase(), side: String(input.side || 'buy').toLowerCase(), quantity: Number(input.quantity || 0), price: Number(input.price || 0), timestamp: input.timestamp || new Date().toISOString(), commission: Number(input.commission || 0), slippage: Number(input.slippage || 0),
  };
}
export function createPaperPosition(input = {}) {
  return {
    symbol: String(input.symbol || '').toUpperCase(), quantity: Number(input.quantity || 0), averagePrice: Number(input.averagePrice || 0), marketPrice: Number(input.marketPrice || 0), unrealizedPnL: Number(input.unrealizedPnL || 0), realizedPnL: Number(input.realizedPnL || 0), updatedAt: input.updatedAt || new Date().toISOString(),
  };
}
