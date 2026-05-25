let signalCounter = 0;

export function createAlphaSignal(input) {
  signalCounter += 1;

  return {
    id: `alpha-${Date.now()}-${signalCounter}`,
    symbol: String(input.symbol || '').toUpperCase(),
    type: input.type || 'unknown',
    category: input.category || 'market-structure',
    direction: input.direction || 'neutral',
    confidence: Number(input.confidence || 0),
    strength: Number(input.strength || 0),
    timeframe: input.timeframe || '1m',
    reason: input.reason || '',
    features: input.features || {},
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
