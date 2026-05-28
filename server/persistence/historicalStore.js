const SUPPORTED_TIMEFRAMES = new Set(['1m', '5m', '15m', '1H']);

const FALLBACK_REASON = 'Using fallback demo candles because no historical market data is available.';

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

function seededUnit(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function getSymbolBasePrice(symbol) {
  const s = String(symbol).toUpperCase();
  if (/^(EUR|GBP|AUD|NZD)/.test(s) || /=X$/.test(s)) return 1.1;
  if (/JPY/.test(s)) return 150;
  if (/BTC/.test(s)) return 60000;
  if (/ETH/.test(s)) return 3000;
  return 500;
}

function getFallbackCandles(symbol = 'SPY', timeframe = '1m', count = 360) {
  const normalized = String(symbol || 'SPY').toUpperCase();
  const timeframeMs = timeframeToMs(timeframe) || 60_000;
  const now = alignTimestamp(Date.now(), timeframeMs);

  const candles = [];
  let price = getSymbolBasePrice(normalized);
  const volumeBase0 = price < 10 ? 1_000_000_000 : price < 1000 ? 150_000 : 50;
  let volumeBase = volumeBase0;

  for (let i = count - 1; i >= 0; i -= 1) {
    const t = now - (i * timeframeMs);
    const wave = Math.sin((count - i) / 15) * 0.0018;
    const drift = (seededUnit(count - i) - 0.5) * 0.0012;
    const change = wave + drift;

    const open = price;
    const close = Math.max(1, open * (1 + change));

    const wickUp = Math.max(0.0004, seededUnit((count - i) + 7) * 0.0025);
    const wickDown = Math.max(0.0004, seededUnit((count - i) + 13) * 0.0025);
    const high = Math.max(open, close) * (1 + wickUp);
    const low = Math.min(open, close) * (1 - wickDown);

    const volatilityPulse = 1 + Math.sin((count - i) / 9) * 0.35;
    const noise = 0.75 + seededUnit((count - i) + 17) * 0.6;
    const volume = Math.max(5_000, Math.round(volumeBase * volatilityPulse * noise));

    candles.push({
      symbol: normalized,
      t,
      o: Number(open.toFixed(4)),
      h: Number(high.toFixed(4)),
      l: Number(low.toFixed(4)),
      c: Number(close.toFixed(4)),
      v: volume,
      source: 'fallback_demo',
      isFallbackDemo: true,
    });

    price = close;
    volumeBase = Math.max(volumeBase0 * 0.5, volumeBase + (seededUnit((count - i) + 23) - 0.5) * volumeBase0 * 0.01);
  }

  return candles;
}

function getStoredOneMinuteCandles(_symbol = 'SPY') {
  return [];
}

function buildCandlePayload(candles, normalized, timeframe, isFallback) {
  return {
    symbol: normalized,
    timeframe,
    source: isFallback ? 'fallback_demo' : 'historical_store',
    isFallbackDemo: isFallback,
    warning: isFallback ? FALLBACK_REASON : null,
    candles,
  };
}

export function getCandlesWithMeta(symbol = 'SPY', timeframe = '1m') {
  const normalized = String(symbol || 'SPY').toUpperCase();
  const normalizedTimeframe = SUPPORTED_TIMEFRAMES.has(timeframe) ? timeframe : '1m';

  const oneMinuteCandles = getStoredOneMinuteCandles(normalized);

  if (!Array.isArray(oneMinuteCandles) || oneMinuteCandles.length === 0) {
    const fallbackCandles = getFallbackCandles(normalized, normalizedTimeframe, 360);
    return buildCandlePayload(fallbackCandles, normalized, normalizedTimeframe, true);
  }

  if (normalizedTimeframe === '1m') {
    return buildCandlePayload(oneMinuteCandles, normalized, normalizedTimeframe, false);
  }

  const aggregated = aggregateCandles(oneMinuteCandles, normalizedTimeframe);
  return buildCandlePayload(aggregated, normalized, normalizedTimeframe, false);
}

export function getCandles(symbol = 'SPY', timeframe = '1m') {
  return getCandlesWithMeta(symbol, timeframe).candles;
}

export { FALLBACK_REASON };
