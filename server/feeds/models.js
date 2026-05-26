function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  return date.toISOString();
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

export function createNormalizedTick(input = {}) {
  return {
    symbol: normalizeSymbol(input.symbol),
    price: toFiniteNumber(input.price, 0),
    bid: toFiniteNumber(input.bid),
    ask: toFiniteNumber(input.ask),
    volume: toFiniteNumber(input.volume, 0),
    source: String(input.source || 'fallback_demo'),
    timestamp: normalizeTimestamp(input.timestamp),
    sequence: Number.isInteger(input.sequence) ? input.sequence : null,
  };
}

export function createNormalizedCandle(input = {}) {
  return {
    symbol: normalizeSymbol(input.symbol),
    timeframe: String(input.timeframe || '1m'),
    open: toFiniteNumber(input.open, 0),
    high: toFiniteNumber(input.high, 0),
    low: toFiniteNumber(input.low, 0),
    close: toFiniteNumber(input.close, 0),
    volume: toFiniteNumber(input.volume, 0),
    source: String(input.source || 'fallback_demo'),
    timestamp: normalizeTimestamp(input.timestamp),
  };
}

export function createNormalizedOrderBook(input = {}) {
  const bids = Array.isArray(input.bids) ? input.bids : [];
  const asks = Array.isArray(input.asks) ? input.asks : [];

  return {
    symbol: normalizeSymbol(input.symbol),
    bids,
    asks,
    spread: toFiniteNumber(input.spread, null),
    imbalance: toFiniteNumber(input.imbalance, null),
    source: String(input.source || 'fallback_demo'),
    timestamp: normalizeTimestamp(input.timestamp),
  };
}

export function createFeedStatus(input = {}) {
  return {
    source: String(input.source || 'fallback_demo'),
    status: String(input.status || 'idle_demo'),
    connected: Boolean(input.connected),
    symbols: Array.isArray(input.symbols) ? input.symbols.map(normalizeSymbol).filter(Boolean) : [],
    lastMessageAt: input.lastMessageAt ? normalizeTimestamp(input.lastMessageAt) : null,
    latencyMs: toFiniteNumber(input.latencyMs, null),
    warnings: Array.isArray(input.warnings) ? input.warnings.map((w) => String(w)) : [],
  };
}
