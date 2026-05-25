const SUPPORTED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1H']);

function timeframeToMs(timeframe) {
  switch (timeframe) {
    case '1m':
      return 60_000;
    case '5m':
      return 5 * 60_000;
    case '15m':
      return 15 * 60_000;
    case '1H':
      return 60 * 60_000;
    default:
      return null;
  }
}

function alignTimestamp(timestampMs, timeframeMs) {
  return Math.floor(timestampMs / timeframeMs) * timeframeMs;
}

function aggregateCandles(sourceCandles, targetTimeframe) {
  const targetMs = timeframeToMs(targetTimeframe);
  if (!targetMs) return [];

  const buckets = new Map();
  for (const candle of sourceCandles) {
    const bucketTs = alignTimestamp(candle.t, targetMs);
    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, {
        ...candle,
        t: bucketTs,
      });
      continue;
    }

    existing.h = Math.max(existing.h, candle.h);
    existing.l = Math.min(existing.l, candle.l);
    existing.c = candle.c;
    existing.v += candle.v;
  }

  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

function getMockCandles(symbol = 'SPY') {
  const normalized = String(symbol || 'SPY').toUpperCase();
  const now = alignTimestamp(Date.now(), 60_000);

  return [
    {
      t: now - 120000,
      o: 100,
      h: 101,
      l: 99.5,
      c: 100.4,
      v: 1000,
    },
    {
      t: now - 60000,
      o: 100.4,
      h: 100.9,
      l: 100.1,
      c: 100.7,
      v: 850,
    },
    {
      t: now,
      o: 100.7,
      h: 101.2,
      l: 100.6,
      c: 101,
      v: 910,
    },
  ].map((candle) => ({
    ...candle,
    symbol: normalized,
  }));
}

export function getCandles(symbol = 'SPY', timeframe = '1m') {
  const normalizedTimeframe = SUPPORTED_TIMEFRAMES.has(timeframe) ? timeframe : '1m';

  // Base storage currently behaves like minute-level history.
  const oneMinuteCandles = getMockCandles(symbol);

  if (normalizedTimeframe === '1m') return oneMinuteCandles;
  if (normalizedTimeframe === '5m') return aggregateCandles(oneMinuteCandles, '5m');
  if (normalizedTimeframe === '15m') return aggregateCandles(oneMinuteCandles, '15m');
  if (normalizedTimeframe === '1H') return aggregateCandles(oneMinuteCandles, '1H');

  return [];
}
