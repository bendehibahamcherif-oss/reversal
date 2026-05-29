import { feedManager } from '../feeds/feedManager.js';
import { chartDataEngine } from '../charting/chartDataEngine.js';
import { buildVolumeProfile } from '../charting/volumeProfileEngine.js';
import { alertStore } from './AlertStore.js';
import { alertHistoryStore } from './AlertHistoryStore.js';
import { alertRuleEvaluator } from './AlertRuleEvaluator.js';

const EVAL_INTERVAL_MS = 30_000;   // evaluate every 30 s
const STARTUP_DELAY_MS =  5_000;   // first cycle after server settles

class AlertEngine {
  constructor() {
    this._timer       = null;
    this._running     = false;
    // symbol → { price, ema9, ema20, vwap, poc, vah, val }
    this._prevState   = new Map();
    this._stats = {
      evaluationCount:  0,
      triggerCount:     0,
      lastEvaluationAt: null,
      startedAt:        null,
    };
  }

  start() {
    if (this._running) return;
    this._running     = true;
    this._stats.startedAt = new Date().toISOString();
    setTimeout(() => this._evaluateCycle(), STARTUP_DELAY_MS);
    this._timer = setInterval(() => this._evaluateCycle(), EVAL_INTERVAL_MS);
    console.info('[AlertEngine] started', { intervalMs: EVAL_INTERVAL_MS });
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
    console.info('[AlertEngine] stopped');
  }

  // Force an immediate evaluation — used by tests / manual triggers
  async forceEvaluate() {
    return this._evaluateCycle();
  }

  // ── Core cycle ────────────────────────────────────────────────────────────

  async _evaluateCycle() {
    const active = alertStore.getActive();
    if (!active.length) return;

    this._stats.evaluationCount++;
    this._stats.lastEvaluationAt = new Date().toISOString();

    // Group by symbol — fetch market data once per symbol
    const bySymbol = new Map();
    for (const alert of active) {
      if (!bySymbol.has(alert.symbol)) bySymbol.set(alert.symbol, []);
      bySymbol.get(alert.symbol).push(alert);
    }

    for (const [symbol, alerts] of bySymbol) {
      await this._evaluateSymbol(symbol, alerts).catch((e) =>
        console.error('[AlertEngine] symbol error', { symbol, error: e?.message }),
      );
    }
  }

  async _evaluateSymbol(symbol, alerts) {
    // ── 1. Tick (fast, cached) ────────────────────────────────────────────
    const tickRaw  = await feedManager.getLatestTick(symbol).catch(() => null);
    const tick     = tickRaw ? { price: tickRaw.price, volume: tickRaw.volume } : null;

    // ── 2. Candles + indicators ───────────────────────────────────────────
    let candles       = [];
    let latestCandle  = null;
    let indicators    = { rsi14: null, ema9: null, ema20: null, vwap: null, volumeAvg: null };
    let volumeProfile = { poc: null, vah: null, val: null };

    try {
      const candlePayload = await chartDataEngine.getCandles(symbol, '1m', 200);
      candles      = candlePayload.candles || [];
      latestCandle = candles.length ? candles[candles.length - 1] : null;

      if (candles.length > 1) {
        const indPayload = await chartDataEngine.getIndicators(
          symbol, '1m',
          ['rsi14', 'ema9', 'ema20', 'vwap', 'volume_avg'],
          candlePayload,
        );
        const lastVal = (arr) => (Array.isArray(arr) && arr.length ? (arr[arr.length - 1]?.value ?? null) : null);
        if (Array.isArray(indPayload.indicators)) {
          for (const ind of indPayload.indicators) {
            const v = lastVal(ind.values);
            if (ind.name === 'rsi14')       indicators.rsi14     = v;
            else if (ind.name === 'ema9')   indicators.ema9      = v;
            else if (ind.name === 'ema20')  indicators.ema20     = v;
            else if (ind.name === 'vwap')   indicators.vwap      = v;
            else if (ind.name === 'volume_avg') indicators.volumeAvg = v;
          }
        }
      }

      // ── 3. Volume profile (sync after candles) ────────────────────────
      if (candles.length > 0) {
        const vp = buildVolumeProfile(candles, 50);
        volumeProfile = { poc: vp.poc, vah: vp.vah, val: vp.val };
      }
    } catch (e) {
      console.warn('[AlertEngine] data fetch failed', { symbol, error: e?.message });
    }

    const prevState = this._prevState.get(symbol) || null;
    const ctx = { tick, candle: latestCandle, indicators, volumeProfile, prevState };

    // ── 4. Evaluate each alert ────────────────────────────────────────────
    for (const alert of alerts) {
      if (!this._canTrigger(alert)) continue;
      const result = alertRuleEvaluator.evaluate(alert, ctx);
      if (result.triggered) await this._triggerAlert(alert, result);
    }

    // ── 5. Snapshot state for cross detection next cycle ─────────────────
    this._prevState.set(symbol, {
      price: tick?.price ?? null,
      ema9:  indicators.ema9,
      ema20: indicators.ema20,
      vwap:  indicators.vwap,
      poc:   volumeProfile.poc,
      vah:   volumeProfile.vah,
      val:   volumeProfile.val,
    });
  }

  // ── Cooldown gate ─────────────────────────────────────────────────────────

  _canTrigger(alert) {
    if (!alert.enabled) return false;
    if (alert.expiresAt && new Date(alert.expiresAt) < new Date()) return false;

    switch (alert.cooldownMode) {
      case 'always':          return true;
      case 'once':            return !alert.lastTriggeredAt;
      case 'cooldown_minutes':
      default: {
        if (!alert.lastTriggeredAt) return true;
        const cooldownMs = (Number(alert.cooldownMinutes) || 60) * 60_000;
        return Date.now() - new Date(alert.lastTriggeredAt).getTime() >= cooldownMs;
      }
    }
  }

  // ── Trigger handling ──────────────────────────────────────────────────────

  async _triggerAlert(alert, result) {
    this._stats.triggerCount++;

    alertHistoryStore.record({
      alertId:      alert.id,
      symbol:       alert.symbol,
      type:         alert.type,
      triggerValue: result.value,
      reason:       result.reason,
    });

    alertStore.recordTrigger(alert.id);

    console.info('[AlertEngine] TRIGGERED', {
      alertId: alert.id,
      symbol:  alert.symbol,
      type:    alert.type,
      reason:  result.reason,
      value:   result.value,
    });
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  getDiagnostics() {
    const active = alertStore.getActive();
    const all    = alertStore.getAll();
    return {
      running:         this._running,
      evaluationCount: this._stats.evaluationCount,
      triggerCount:    this._stats.triggerCount,
      lastEvaluationAt: this._stats.lastEvaluationAt,
      startedAt:       this._stats.startedAt,
      activeAlerts:    active.length,
      totalAlerts:     all.length,
      symbolsTracked:  [...new Set(active.map((a) => a.symbol))],
      evalIntervalMs:  EVAL_INTERVAL_MS,
    };
  }
}

export const alertEngine = new AlertEngine();
