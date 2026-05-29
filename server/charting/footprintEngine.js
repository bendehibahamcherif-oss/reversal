// ── Footprint Chart Engine ────────────────────────────────────────────────────
//
// Aggregates OHLCV candle data into per-bar, per-price-level footprint clusters.
//
// Price-level aggregation model (synthetic OHLCV):
//   Volume is distributed across price levels proportional to the overlap of
//   each level with the candle's high-low range (same approach as Volume Profile).
//   Bid/ask split is estimated from candle structure:
//     upper wick levels  → seller-aggressive (70% bid, 30% ask)
//     lower wick levels  → buyer-aggressive  (30% bid, 70% ask)
//     body (bullish bar) → slight ask bias   (60% ask, 40% bid)
//     body (bearish bar) → slight bid bias   (40% ask, 60% bid)
//
// Imbalance logic:
//   Standard footprint diagonal comparison:
//     bullish_imbalance at level[i]: askVol[i] / bidVol[i+1] >= threshold
//     bearish_imbalance at level[i]: bidVol[i] / askVol[i-1] >= threshold
//   Stacked imbalance: ≥3 consecutive same-direction imbalances within one bar.
//
// Absorption:
//   High volume (>2.5× mean level volume) at the candle's extreme (top or bottom)
//   where price reversed — signals large passive orders absorbing aggressive flow.
//
// Fallback behavior:
//   When source is 'ohlcv_synthetic', imbalancesDisabled=true is set and no
//   imbalance / absorption markers are computed. All levels are still returned.
//   The UI MUST display an explicit fallback badge when fallback=true.

import { wsEmit } from '../websocket/wsEmitter.js';

// ── Cluster size auto-scaling ─────────────────────────────────────────────────
// Returns a sensible default price-per-level based on price magnitude.
const CLUSTER_SCALE = [
  { max: 1,        size: 0.0001 },
  { max: 10,       size: 0.01   },
  { max: 100,      size: 0.05   },
  { max: 1_000,    size: 0.25   },
  { max: 10_000,   size: 1.0    },
  { max: 100_000,  size: 10.0   },
  { max: Infinity, size: 50.0   },
];

function autoClusterSize(price) {
  for (const { max, size } of CLUSTER_SCALE) {
    if (price < max) return size;
  }
  return 1.0;
}

// Ensure clusterSize produces at most MAX_LEVELS_PER_BAR levels for this candle
const MAX_LEVELS_PER_BAR = 100;

function clampClusterSize(high, low, requested) {
  const range = high - low;
  if (range <= 0) return requested;
  const minSize = range / MAX_LEVELS_PER_BAR;
  return Math.max(requested, minSize);
}

// ── Single bar computation ────────────────────────────────────────────────────

function computeBar(candle, clusterSize, imbalanceThreshold, imbalancesDisabled) {
  const time   = Number(candle.time  ?? candle.t) || 0;
  const open   = Number(candle.open  ?? candle.o) || 0;
  const high   = Number(candle.high  ?? candle.h) || 0;
  const low    = Number(candle.low   ?? candle.l) || 0;
  const close  = Number(candle.close ?? candle.c) || 0;
  const volume = Number(candle.volume ?? candle.v) || 0;

  const range = high - low;
  const effectiveSize = clampClusterSize(high, low, clusterSize);

  if (range < 1e-10 || effectiveSize <= 0) {
    return {
      time, open, high, low, close, volume,
      delta: 0, levels: [], maxLevelVol: 0,
      poc: close, absorption: null, stackedImbalance: null,
    };
  }

  // Build price levels aligned to clusterSize grid
  const gridBottom = Math.floor(low / effectiveSize) * effectiveSize;
  const levels     = [];

  const bodyHigh = Math.max(open, close);
  const bodyLow  = Math.min(open, close);
  const isBullish = close >= open;

  for (let lvl = gridBottom; lvl <= high + effectiveSize * 0.5; lvl += effectiveSize) {
    const binLo  = lvl;
    const binHi  = lvl + effectiveSize;
    const overlap = Math.min(high, binHi) - Math.max(low, binLo);
    if (overlap <= 1e-12) continue;

    const totalVol = volume * (overlap / range);
    const midPrice = lvl + effectiveSize * 0.5;

    // Bid/ask split from candle structure
    let askFrac;
    if (midPrice > bodyHigh) {
      // Upper wick — sellers absorbed buyers here
      askFrac = 0.30;
    } else if (midPrice < bodyLow) {
      // Lower wick — buyers absorbed sellers here
      askFrac = 0.70;
    } else {
      // Body
      askFrac = isBullish ? 0.60 : 0.40;
    }

    levels.push({
      price:         Number(lvl.toFixed(8)),
      bidVol:        Math.round(totalVol * (1 - askFrac)),
      askVol:        Math.round(totalVol * askFrac),
      totalVol:      Math.round(totalVol),
      imbalance:     null,
      imbalanceRatio: null,
    });
  }

  if (levels.length === 0) {
    return {
      time, open, high, low, close, volume,
      delta: 0, levels: [], maxLevelVol: 0,
      poc: close, absorption: null, stackedImbalance: null,
    };
  }

  // Sort levels low → high (should already be, but guard against float drift)
  levels.sort((a, b) => a.price - b.price);

  const maxLevelVol = Math.max(...levels.map((l) => l.totalVol));
  const poc = levels.reduce((best, l) => (l.totalVol > best.totalVol ? l : best), levels[0]).price;
  const delta = Math.round(levels.reduce((s, l) => s + l.askVol - l.bidVol, 0));

  let absorption     = null;
  let stackedImbalance = null;

  if (!imbalancesDisabled) {
    // ── Diagonal imbalance (standard footprint) ───────────────────────────
    // Bullish at level[i]: ask[i] / bid[i+1] >= threshold
    // Bearish at level[i]: bid[i] / ask[i-1] >= threshold
    for (let i = 0; i < levels.length; i++) {
      const above = levels[i + 1];
      const below = levels[i - 1];

      if (above && above.bidVol > 0) {
        const ratio = levels[i].askVol / above.bidVol;
        if (ratio >= imbalanceThreshold) {
          levels[i].imbalance      = 'bullish';
          levels[i].imbalanceRatio = Number(ratio.toFixed(2));
        }
      }
      if (below && below.askVol > 0) {
        const ratio = levels[i].bidVol / below.askVol;
        if (ratio >= imbalanceThreshold) {
          // Only override if not already marked bullish (bullish takes priority
          // when both signals coincide at the same level)
          if (!levels[i].imbalance) {
            levels[i].imbalance      = 'bearish';
            levels[i].imbalanceRatio = Number(ratio.toFixed(2));
          }
        }
      }
    }

    // ── Stacked imbalance: ≥3 consecutive same-direction imbalances ───────
    stackedImbalance = detectStackedImbalance(levels);

    // ── Absorption: high volume at extreme with price reversal ────────────
    const meanVol = levels.reduce((s, l) => s + l.totalVol, 0) / levels.length;
    const absThreshold = meanVol * 2.5;
    const topLevel = levels[levels.length - 1];
    const botLevel = levels[0];

    if (topLevel.totalVol > absThreshold && close < high - range * 0.3) {
      absorption = { type: 'buy_absorption', price: topLevel.price, volume: topLevel.totalVol };
    } else if (botLevel.totalVol > absThreshold && close > low + range * 0.3) {
      absorption = { type: 'sell_absorption', price: botLevel.price, volume: botLevel.totalVol };
    }
  }

  return {
    time, open, high, low, close, volume, delta,
    levels, maxLevelVol, poc, absorption, stackedImbalance,
  };
}

function detectStackedImbalance(levels) {
  const MIN_STACK = 3;
  let bullishRun = 0;
  let bearishRun = 0;
  let maxBullish = 0;
  let maxBearish = 0;

  for (const l of levels) {
    if (l.imbalance === 'bullish') {
      bullishRun++;
      bearishRun = 0;
      if (bullishRun > maxBullish) maxBullish = bullishRun;
    } else if (l.imbalance === 'bearish') {
      bearishRun++;
      bullishRun = 0;
      if (bearishRun > maxBearish) maxBearish = bearishRun;
    } else {
      bullishRun = 0;
      bearishRun = 0;
    }
  }

  if (maxBullish >= MIN_STACK) return { type: 'bullish', count: maxBullish };
  if (maxBearish >= MIN_STACK) return { type: 'bearish', count: maxBearish };
  return null;
}

// ── Footprint Engine ──────────────────────────────────────────────────────────

const PUSH_INTERVAL_MS = 5_000;

class FootprintEngine {
  constructor() {
    // Last pushed state per symbol for WS push dedup
    this._lastPushKey = new Map();
    this._pushTimer   = null;
    // Latest candle payloads for WS push
    this._latestCandles = new Map();
  }

  // ── Public: compute full footprint for a candle array ────────────────────

  compute(candles, sourceProvider, options = {}) {
    const candleSource = String(sourceProvider || 'unknown');
    const isSynthetic  = candleSource === 'fallback_demo' || candleSource === 'ohlcv_synthetic';

    const {
      imbalanceThreshold = 3.0,
    } = options;

    // imbalancesDisabled when data is synthetic (no real bid/ask aggression info)
    const imbalancesDisabled = isSynthetic;

    // Resolve clusterSize: use explicit param or auto-scale from median price
    let clusterSize = options.clusterSize;
    if (!clusterSize || clusterSize <= 0) {
      const refPrice = candles.length
        ? Number(candles[Math.floor(candles.length / 2)]?.close
            ?? candles[Math.floor(candles.length / 2)]?.c) || 500
        : 500;
      clusterSize = autoClusterSize(refPrice);
    }
    clusterSize = Math.max(1e-8, Number(clusterSize));

    const bars = (Array.isArray(candles) ? candles : []).map((c) =>
      computeBar(c, clusterSize, Number(imbalanceThreshold) || 3.0, imbalancesDisabled),
    );

    return {
      bars,
      clusterSize,
      imbalanceThreshold: Number(imbalanceThreshold) || 3.0,
      source:             isSynthetic ? 'ohlcv_synthetic' : candleSource,
      fallback:           isSynthetic,
      imbalancesDisabled,
    };
  }

  // ── Public: cache latest candle batch for WS push ─────────────────────────

  setLatestCandles(symbol, candles, source) {
    this._latestCandles.set(String(symbol).toUpperCase(), { candles, source });
  }

  // ── Public: start / stop WS push loop ────────────────────────────────────

  start() {
    if (this._pushTimer) return;
    this._pushTimer = setInterval(() => this._push(), PUSH_INTERVAL_MS);
    console.log('[FootprintEngine] started, push interval', PUSH_INTERVAL_MS, 'ms');
  }

  stop() {
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
  }

  // ── Private: push latest bar footprint to WebSocket clients ──────────────

  _push() {
    for (const [symbol, { candles, source }] of this._latestCandles) {
      if (!candles.length) continue;

      const lastCandle = candles[candles.length - 1];
      const isSynthetic = source === 'fallback_demo' || source === 'ohlcv_synthetic';
      const clusterSize = autoClusterSize(
        Number(lastCandle.close ?? lastCandle.c) || 500,
      );
      const bar = computeBar(lastCandle, clusterSize, 3.0, isSynthetic);

      // Dedup: only push if the bar's time or maxLevelVol changed
      const key = `${bar.time}:${bar.maxLevelVol}:${bar.delta}`;
      if (this._lastPushKey.get(symbol) === key) continue;
      this._lastPushKey.set(symbol, key);

      wsEmit('footprint_update', {
        symbol,
        timeframe:          '1m',
        source:             isSynthetic ? 'ohlcv_synthetic' : source,
        fallback:           isSynthetic,
        imbalancesDisabled: isSynthetic,
        clusterSize,
        bar,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

export const footprintEngine = new FootprintEngine();
