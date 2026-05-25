function randomIdPart() {
  return Math.random().toString(36).slice(2, 8);
}

export function createPatternSignal({
  symbol,
  pattern,
  category,
  direction = 'neutral',
  confidence = 0.5,
  timeframe = '1m',
  reason = '',
  features = {},
}) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const now = Date.now();

  return {
    id: `ptn_${now}_${randomIdPart()}`,
    symbol: normalizedSymbol,
    pattern: String(pattern || 'unknown'),
    category: String(category || 'general'),
    direction: ['bullish', 'bearish', 'neutral'].includes(direction) ? direction : 'neutral',
    confidence: Math.max(0, Math.min(0.99, Number(confidence) || 0)),
    timeframe: String(timeframe || '1m'),
    reason: String(reason || ''),
    features: features && typeof features === 'object' ? features : {},
    createdAt: new Date(now).toISOString(),
  };
}
