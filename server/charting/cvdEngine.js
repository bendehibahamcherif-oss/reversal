// ── Cumulative Delta Volume (CVD) Engine ─────────────────────────────────────
//
// Source hierarchy (applied in priority order):
//   1. tick_direction  — price clearly at ask (buy) or bid (sell) → fallback: false
//   2. l1_midpoint     — price inside spread, midpoint approx used → fallback: true
//   3. ohlcv_synthetic — no bid/ask data; delta from close position → fallback: true
//
// Session reset: NYSE regular session 09:30–16:00 ET.
// When a new session starts and the engine has accumulated state for a prior
// session, cumDelta resets to 0 for that symbol.

import { wsEmit } from '../websocket/wsEmitter.js';

const ET_OFFSET_MS     = -5 * 3_600_000;   // EST (UTC-5), conservative non-DST
const SESSION_START_MS = 9.5 * 3_600_000;  // 09:30 in ms since midnight ET
const SESSION_END_MS   = 16  * 3_600_000;  // 16:00 in ms since midnight ET
const PUSH_INTERVAL_MS = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Return midnight-ET expressed as UTC ms for the trading day containing `utcMs`
function etSessionDay(utcMs) {
  const etMs = utcMs + ET_OFFSET_MS;
  const d = new Date(etMs);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ET_OFFSET_MS;
}

// True if `utcMs` falls within regular NYSE session hours on its day
function isSessionOpen(utcMs) {
  const etMs = utcMs + ET_OFFSET_MS;
  const dayMs = Math.floor(etMs / 86_400_000) * 86_400_000;
  const msSinceMidnight = etMs - dayMs;
  return msSinceMidnight >= SESSION_START_MS && msSinceMidnight < SESSION_END_MS;
}

// Find the most recent trading day (walk back up to 7 days to skip weekends)
function mostRecentTradingDay() {
  for (let d = 0; d < 7; d++) {
    const probe = Date.now() - d * 86_400_000;
    const etMs  = probe + ET_OFFSET_MS;
    const dow   = new Date(etMs).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) return etSessionDay(probe);
  }
  return etSessionDay(Date.now());
}

// ── Tick-level delta helpers ──────────────────────────────────────────────────

function deltaFromTick(tick) {
  const vol = Number(tick.volume) || 0;
  if (vol === 0) return null;

  const bid = tick.bid != null ? Number(tick.bid) : null;
  const ask = tick.ask != null ? Number(tick.ask) : null;
  const price = Number(tick.price) || 0;

  if (bid != null && ask != null && bid < ask) {
    // Clear at-ask (buyer aggressor)
    if (price >= ask) return { delta: vol,  source: 'tick_direction', fallback: false };
    // Clear at-bid (seller aggressor)
    if (price <= bid) return { delta: -vol, source: 'tick_direction', fallback: false };
    // Inside spread — midpoint approximation
    const mid = (bid + ask) / 2;
    const sign = price >= mid ? 1 : -1;
    return { delta: sign * vol * 0.5, source: 'l1_midpoint', fallback: true };
  }

  return null; // No bid/ask — caller should fall back to synthetic
}

// ── Candle-level delta (synthetic OHLCV) ─────────────────────────────────────

function deltaFromCandle(candle) {
  const vol  = Number(candle.volume ?? candle.v) || 0;
  const high = Number(candle.high   ?? candle.h) || 0;
  const low  = Number(candle.low    ?? candle.l) || 0;
  const close= Number(candle.close  ?? candle.c) || 0;
  const range = high - low;
  const buyFraction = range > 1e-10 ? (close - low) / range : 0.5;
  return {
    delta:   vol * (2 * buyFraction - 1),
    source:  'ohlcv_synthetic',
    fallback: true,
  };
}

// ── CVD Engine ────────────────────────────────────────────────────────────────

class CVDEngine {
  constructor() {
    // Live accumulation state per symbol
    // Map<symbol, { cumDelta, ticks, source, fallback, sessionDay, lastResetAt }>
    this._liveState = new Map();
    this._pushTimer  = null;
  }

  // ── Public: called by feedManager shim / external tick producers ──────────

  ingestTick(tick) {
    const symbol = String(tick.symbol || '').toUpperCase();
    const state  = this._getLiveState(symbol);
    this._maybeResetLive(state, symbol);

    const result = deltaFromTick(tick);
    if (result) {
      state.cumDelta += result.delta;
      state.source    = result.source;
      state.fallback  = result.fallback;
      state.ticks    += 1;
    }
  }

  // ── Public: bar-aligned CVD from historical candles (REST endpoint) ────────

  computeFromCandles(candles, sourceProvider = 'unknown') {
    if (!Array.isArray(candles) || candles.length === 0) {
      return { bars: [], overallSource: 'ohlcv_synthetic', overallFallback: true, sessionResets: 0 };
    }

    const bars = [];
    let cumDelta    = 0;
    let prevDay     = null;
    let sessionResets = 0;

    for (const c of candles) {
      const time   = Number(c.time ?? c.t) || 0;
      const day    = time > 0 ? etSessionDay(time) : null;

      // Session reset: new trading day and candle falls inside (or after) session open
      const shouldReset = day !== null
        && day !== prevDay
        && prevDay !== null
        && isSessionOpen(time);

      if (shouldReset) {
        cumDelta = 0;
        sessionResets++;
      }
      if (day !== null) prevDay = day;

      const { delta, source, fallback } = deltaFromCandle(c);
      cumDelta += delta;

      bars.push({
        time,
        delta:    Math.round(delta),
        cumDelta: Math.round(cumDelta),
        volume:   Number(c.volume ?? c.v) || 0,
        source,
        fallback,
        sessionReset: shouldReset,
      });
    }

    return {
      bars,
      overallSource:  'ohlcv_synthetic',
      overallFallback: true,
      sessionResets,
    };
  }

  // ── Public: merge live tick-based state onto historical bars ──────────────

  buildCVDPayload(symbol, candles, sourceProvider = 'unknown') {
    const { bars, overallSource, overallFallback, sessionResets } = this.computeFromCandles(candles, sourceProvider);
    const live = this._getLiveState(symbol);

    // If we have live tick-based state and it's more precise, apply it to the
    // last bar so the tail of the chart reflects real buy/sell pressure.
    let effectiveSource   = overallSource;
    let effectiveFallback = overallFallback;

    if (live.ticks > 0 && bars.length > 0) {
      const last  = bars[bars.length - 1];
      const today = mostRecentTradingDay();
      if (live.sessionDay === today) {
        // Replace the last bar's cumDelta with the live value
        last.cumDelta  = Math.round(live.cumDelta);
        last.source    = live.source;
        last.fallback  = live.fallback;
        effectiveSource   = live.source;
        effectiveFallback = live.fallback;
      }
    }

    const sourceClassification = {
      tick_direction:  effectiveSource === 'tick_direction',
      l1_midpoint:     effectiveSource === 'l1_midpoint',
      ohlcv_synthetic: effectiveSource === 'ohlcv_synthetic',
    };

    return {
      bars,
      source:               effectiveSource,
      sourceClassification,
      fallback:             effectiveFallback,
      sessionResets,
      liveState: {
        cumDelta:    Math.round(live.cumDelta),
        ticks:       live.ticks,
        source:      live.source,
        fallback:    live.fallback,
        lastResetAt: live.lastResetAt,
      },
    };
  }

  // ── Public: start WebSocket push loop ─────────────────────────────────────

  start() {
    if (this._pushTimer) return;
    this._pushTimer = setInterval(() => this._push(), PUSH_INTERVAL_MS);
    console.log('[CVDEngine] started, push interval', PUSH_INTERVAL_MS, 'ms');
  }

  stop() {
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _getLiveState(symbol) {
    if (!this._liveState.has(symbol)) {
      this._liveState.set(symbol, {
        cumDelta:    0,
        ticks:       0,
        source:      'ohlcv_synthetic',
        fallback:    true,
        sessionDay:  mostRecentTradingDay(),
        lastResetAt: null,
      });
    }
    return this._liveState.get(symbol);
  }

  _maybeResetLive(state, symbol) {
    const now     = Date.now();
    const today   = mostRecentTradingDay();
    const inSession = isSessionOpen(now);

    if (inSession && state.sessionDay !== today) {
      console.log('[CVDEngine] session reset', { symbol });
      state.cumDelta    = 0;
      state.ticks       = 0;
      state.source      = 'ohlcv_synthetic';
      state.fallback    = true;
      state.sessionDay  = today;
      state.lastResetAt = new Date().toISOString();
    }
  }

  _push() {
    for (const [symbol, state] of this._liveState) {
      wsEmit('cumulative_delta', {
        symbol,
        cumDelta:    Math.round(state.cumDelta),
        ticks:       state.ticks,
        source:      state.source,
        fallback:    state.fallback,
        sessionDay:  state.sessionDay,
        lastResetAt: state.lastResetAt,
        timestamp:   new Date().toISOString(),
      });
    }
  }
}

export const cvdEngine = new CVDEngine();
