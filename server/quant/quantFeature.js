let quantFeatureSequence = 0;

export function createQuantFeature({
  symbol,
  category,
  name,
  value,
  timeframe = null,
  source,
  confidence = null,
  metadata = {},
}) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const createdAt = new Date().toISOString();

  quantFeatureSequence += 1;

  return {
    id: `${normalizedSymbol || 'UNKNOWN'}-${Date.now()}-${quantFeatureSequence}`,
    symbol: normalizedSymbol,
    category: String(category || 'unknown'),
    name: String(name || 'unnamed_feature'),
    value: Number.isFinite(Number(value)) ? Number(value) : 0,
    timeframe: timeframe ? String(timeframe) : null,
    source: String(source || 'unknown'),
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt,
  };
}
