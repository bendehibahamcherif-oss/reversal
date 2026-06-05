/**
 * Canonical OHLCV candle schema for historical data ingestion.
 * All providers must normalize their output to this shape before storage.
 */

export const VALID_TIMEFRAMES = ['1m','5m','15m','30m','1h','4h','1d','1w'];
export const VALID_SESSION_TYPES = ['regular','extended','overnight','unknown'];
export const VALID_SOURCE_TYPES = ['delayed_rest','market_data','realtime','demo'];

/**
 * Validate and normalize a raw candle object from a provider.
 * Returns { ok, candle } or { ok: false, error }.
 */
export function normalizeCandle(raw, defaults = {}) {
  const ts = raw.timestamp ?? raw.t ?? raw.time;
  let timestampMs;
  if (typeof ts === 'string') {
    timestampMs = Date.parse(ts);
  } else if (typeof ts === 'number') {
    timestampMs = ts > 1e12 ? ts : ts * 1000;
  } else {
    return { ok: false, error: 'missing_timestamp' };
  }
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return { ok: false, error: 'invalid_timestamp' };
  }

  const open  = Number(raw.open  ?? raw.o);
  const high  = Number(raw.high  ?? raw.h);
  const low   = Number(raw.low   ?? raw.l);
  const close = Number(raw.close ?? raw.c);
  const volume = Number(raw.volume ?? raw.v) || 0;

  if (!Number.isFinite(close) || close <= 0) return { ok: false, error: 'invalid_close' };

  const safeOpen  = Number.isFinite(open)  && open  > 0 ? open  : close;
  const safeHigh  = Number.isFinite(high)  && high  > 0 ? high  : Math.max(safeOpen, close);
  const safeLow   = Number.isFinite(low)   && low   > 0 ? low   : Math.min(safeOpen, close);

  const symbol    = String(raw.symbol    ?? defaults.symbol    ?? '').toUpperCase();
  const timeframe = String(raw.timeframe ?? defaults.timeframe ?? '1d');
  const provider  = String(raw.source    ?? raw.provider ?? defaults.provider ?? 'unknown');
  const session   = String(raw.session   ?? 'regular');
  const sourceType = String(raw.sourceType ?? defaults.sourceType ?? 'market_data');
  const adjusted  = Boolean(raw.adjusted ?? defaults.adjusted ?? false);

  return {
    ok: true,
    candle: {
      timestamp:   timestampMs,
      symbol,
      timeframe,
      open:        safeOpen,
      high:        safeHigh,
      low:         safeLow,
      close,
      volume,
      provider,
      session:     VALID_SESSION_TYPES.includes(session) ? session : 'unknown',
      sourceType:  VALID_SOURCE_TYPES.includes(sourceType) ? sourceType : 'market_data',
      adjusted,
    },
  };
}

/**
 * Validate and normalize a batch of raw candles.
 * Returns { candles, skipped } where skipped is count of invalid rows.
 */
export function normalizeCandleBatch(rawArray, defaults = {}) {
  let skipped = 0;
  const candles = [];
  for (const raw of rawArray) {
    const result = normalizeCandle(raw, defaults);
    if (result.ok) {
      candles.push(result.candle);
    } else {
      skipped += 1;
    }
  }
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return { candles, skipped };
}
