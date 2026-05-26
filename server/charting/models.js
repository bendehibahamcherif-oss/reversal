function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createChartCandle(input = {}) {
  return {
    symbol: String(input.symbol || '').toUpperCase(),
    timeframe: String(input.timeframe || '1m'),
    time: Number(input.time || Date.now()),
    open: toNumber(input.open),
    high: toNumber(input.high),
    low: toNumber(input.low),
    close: toNumber(input.close),
    volume: toNumber(input.volume),
    source: String(input.source || 'unknown'),
  };
}

export function createChartIndicator(input = {}) {
  return {
    symbol: String(input.symbol || '').toUpperCase(),
    timeframe: String(input.timeframe || '1m'),
    name: String(input.name || 'unknown'),
    values: Array.isArray(input.values) ? input.values : [],
    source: String(input.source || 'unknown'),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function createChartOverlay(input = {}) {
  return {
    symbol: String(input.symbol || '').toUpperCase(),
    type: String(input.type || 'marker'),
    label: String(input.label || ''),
    time: Number(input.time || Date.now()),
    price: toNumber(input.price),
    direction: String(input.direction || 'neutral'),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    source: String(input.source || 'derived'),
  };
}

export function createOrderflowSnapshot(input = {}) {
  const bids = Array.isArray(input.bids) ? input.bids : [];
  const asks = Array.isArray(input.asks) ? input.asks : [];
  return {
    symbol: String(input.symbol || '').toUpperCase(),
    bids,
    asks,
    spread: toNumber(input.spread),
    imbalance: toNumber(input.imbalance),
    liquidityPressure: toNumber(input.liquidityPressure),
    source: String(input.source || 'unknown'),
    timestamp: input.timestamp || new Date().toISOString(),
  };
}
