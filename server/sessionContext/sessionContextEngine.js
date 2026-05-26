import { createSessionContext } from './sessionContextModel.js';
import { getCandlesWithMeta } from '../persistence/historicalStore.js';

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

class SessionContextEngine {
  constructor() {
    this.contextStore = new Map();
  }

  computeOpeningGap(candles = []) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return {
        previousClose: 0,
        sessionOpen: 0,
        openingGap: 0,
        openingGapPercent: 0,
        gapDirection: 'flat',
      };
    }

    const sessionOpen = toNumber(candles[0]?.o);
    const previousCloseCandle = candles.find((candle) => Number(candle?.prevSessionClose) > 0);
    const previousClose = toNumber(previousCloseCandle?.prevSessionClose, sessionOpen);
    const openingGap = sessionOpen - previousClose;
    const openingGapPercent = previousClose !== 0 ? (openingGap / previousClose) * 100 : 0;

    let gapDirection = 'flat';
    if (openingGap > 0) gapDirection = 'up';
    else if (openingGap < 0) gapDirection = 'down';

    return {
      previousClose: round(previousClose, 4),
      sessionOpen: round(sessionOpen, 4),
      openingGap: round(openingGap, 4),
      openingGapPercent: round(openingGapPercent, 4),
      gapDirection,
    };
  }

  computeOpeningRange(candles = [], openingMinutes = 30) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return { openingRangeHigh: 0, openingRangeLow: 0 };
    }

    const firstTs = Number(candles[0]?.t || 0);
    const windowEnd = firstTs + (openingMinutes * 60_000);
    const openingWindow = candles.filter((candle) => Number(candle?.t || 0) < windowEnd);
    const source = openingWindow.length > 0 ? openingWindow : [candles[0]];

    const openingRangeHigh = Math.max(...source.map((candle) => toNumber(candle?.h, toNumber(candle?.o))));
    const openingRangeLow = Math.min(...source.map((candle) => toNumber(candle?.l, toNumber(candle?.o))));

    return {
      openingRangeHigh: round(openingRangeHigh, 4),
      openingRangeLow: round(openingRangeLow, 4),
    };
  }

  computeVWAP(candles = []) {
    if (!Array.isArray(candles) || candles.length === 0) {
      return { vwap: 0, vwapDistance: 0 };
    }

    let numerator = 0;
    let denominator = 0;

    for (const candle of candles) {
      const high = toNumber(candle?.h);
      const low = toNumber(candle?.l);
      const close = toNumber(candle?.c);
      const volume = Math.max(0, toNumber(candle?.v));
      const typicalPrice = (high + low + close) / 3;
      numerator += typicalPrice * volume;
      denominator += volume;
    }

    const latestClose = toNumber(candles[candles.length - 1]?.c);
    const vwap = denominator > 0 ? numerator / denominator : latestClose;

    return {
      vwap: round(vwap, 4),
      vwapDistance: round(latestClose - vwap, 4),
    };
  }

  computeSessionBias(context = {}) {
    const gapDirection = context.gapDirection || 'flat';
    const vwapDistance = toNumber(context.vwapDistance);

    if (gapDirection === 'up' && vwapDistance > 0) return 'gap_up_above_vwap';
    if (gapDirection === 'down' && vwapDistance < 0) return 'gap_down_below_vwap';
    if ((gapDirection === 'up' && vwapDistance < 0) || (gapDirection === 'down' && vwapDistance > 0)) return 'mean_reversion_candidate';
    if (gapDirection !== 'flat' && Math.abs(vwapDistance) <= Math.max(0.01, toNumber(context.sessionOpen) * 0.0005)) return 'trend_continuation_candidate';
    return 'neutral';
  }

  computeSessionContext(symbol = 'SPY', timeframe = '1m') {
    const normalizedSymbol = String(symbol || 'SPY').toUpperCase();
    const payload = getCandlesWithMeta(normalizedSymbol, timeframe);
    const candles = Array.isArray(payload?.candles) ? payload.candles : [];
    const warnings = [];

    if (payload?.isFallbackDemo) {
      warnings.push('No real historical candles available. Using fallback demo candles only.');
    }
    if (candles.length === 0) {
      warnings.push('No candles available for session context. Using safe defaults.');
    }

    const gap = this.computeOpeningGap(candles);
    const range = this.computeOpeningRange(candles, 30);
    const vwap = this.computeVWAP(candles);

    const latest = candles[candles.length - 1] || {};
    const sessionHigh = candles.length > 0 ? Math.max(...candles.map((c) => toNumber(c?.h, toNumber(c?.o)))) : 0;
    const sessionLow = candles.length > 0 ? Math.min(...candles.map((c) => toNumber(c?.l, toNumber(c?.o)))) : 0;
    const firstTs = Number(candles[0]?.t || Date.now());
    const latestTs = Number(latest?.t || firstTs);
    const minutesSinceOpen = Math.max(0, Math.floor((latestTs - firstTs) / 60_000));

    const context = createSessionContext({
      id: `${normalizedSymbol}-${timeframe}-${latestTs}`,
      symbol: normalizedSymbol,
      date: new Date(firstTs).toISOString().slice(0, 10),
      timeframe,
      ...gap,
      ...range,
      minutesSinceOpen,
      ...vwap,
      sessionHigh: round(sessionHigh, 4),
      sessionLow: round(sessionLow, 4),
      sessionBias: 'neutral',
      source: payload?.source || 'unknown',
      warnings,
      createdAt: new Date().toISOString(),
    });

    context.sessionBias = this.computeSessionBias(context);
    this.contextStore.set(normalizedSymbol, context);
    return context;
  }

  getLatestContext(symbol = 'SPY') {
    return this.contextStore.get(String(symbol || 'SPY').toUpperCase()) || null;
  }

  clearContext(symbol = 'SPY') {
    const normalized = String(symbol || 'SPY').toUpperCase();
    const existed = this.contextStore.delete(normalized);
    return { symbol: normalized, cleared: existed };
  }
}

export const sessionContextEngine = new SessionContextEngine();
