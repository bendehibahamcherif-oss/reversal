export function normalizeCandle(raw) {
  return {
    timestamp: raw.timestamp || Date.now(),
    open: Number(raw.open || 0),
    high: Number(raw.high || 0),
    low: Number(raw.low || 0),
    close: Number(raw.close || 0),
    volume: Number(raw.volume || 0),
  };
}

export function normalizeTick(raw) {
  return {
    symbol: raw.symbol,
    price: Number(raw.price || 0),
    bid: Number(raw.bid || 0),
    ask: Number(raw.ask || 0),
    timestamp: raw.timestamp || Date.now(),
  };
}
