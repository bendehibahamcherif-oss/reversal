export function createSessionContext(payload = {}) {
  return {
    id: payload.id,
    symbol: payload.symbol,
    date: payload.date,
    timeframe: payload.timeframe,
    previousClose: payload.previousClose,
    sessionOpen: payload.sessionOpen,
    openingGap: payload.openingGap,
    openingGapPercent: payload.openingGapPercent,
    gapDirection: payload.gapDirection,
    openingRangeHigh: payload.openingRangeHigh,
    openingRangeLow: payload.openingRangeLow,
    minutesSinceOpen: payload.minutesSinceOpen,
    vwap: payload.vwap,
    vwapDistance: payload.vwapDistance,
    sessionHigh: payload.sessionHigh,
    sessionLow: payload.sessionLow,
    sessionBias: payload.sessionBias,
    source: payload.source,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    createdAt: payload.createdAt,
  };
}
