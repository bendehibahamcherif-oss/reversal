// Pure, stateless evaluation functions for every alert type.
// Each receives (alert, ctx) and returns { triggered, reason, value } or { triggered: false }.
//
// ctx shape:
//   tick:          { price, volume } — latest cached tick
//   candle:        { open, high, low, close, volume } — last closed candle
//   indicators:    { rsi14, ema9, ema20, vwap, volumeAvg }
//   volumeProfile: { poc, vah, val }
//   prevState:     { price, ema9, ema20, vwap, poc, vah, val } — previous cycle snapshot

const NOT_TRIGGERED = Object.freeze({ triggered: false });

function hit(reason, value) {
  return { triggered: true, reason, value };
}

function fmt(n, decimals = 4) {
  return n == null ? 'null' : Number(n).toFixed(decimals);
}

// Fraction of price used for "touch" proximity (0.1 %)
const DEFAULT_TOUCH_FRACTION = 0.001;

function touchTolerance(alert, refPrice) {
  const fraction = alert.params?.touchTolerance ?? DEFAULT_TOUCH_FRACTION;
  return Math.abs(refPrice) * fraction;
}

// ─── PRICE ────────────────────────────────────────────────────────────────────

function price_above(alert, ctx) {
  const p = ctx.tick?.price;
  if (p == null || alert.threshold == null) return NOT_TRIGGERED;
  return p > alert.threshold ? hit(`Price ${fmt(p)} above ${alert.threshold}`, p) : NOT_TRIGGERED;
}

function price_below(alert, ctx) {
  const p = ctx.tick?.price;
  if (p == null || alert.threshold == null) return NOT_TRIGGERED;
  return p < alert.threshold ? hit(`Price ${fmt(p)} below ${alert.threshold}`, p) : NOT_TRIGGERED;
}

function price_cross(alert, ctx) {
  const p = ctx.tick?.price;
  const prev = ctx.prevState?.price;
  if (p == null || prev == null || alert.threshold == null) return NOT_TRIGGERED;
  const thr = alert.threshold;
  if (prev <= thr && p > thr) return hit(`Price crossed above ${thr} (now ${fmt(p)})`, p);
  if (prev >= thr && p < thr) return hit(`Price crossed below ${thr} (now ${fmt(p)})`, p);
  return NOT_TRIGGERED;
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

function rsi_above(alert, ctx) {
  const rsi = ctx.indicators?.rsi14;
  if (rsi == null || alert.threshold == null) return NOT_TRIGGERED;
  return rsi > alert.threshold ? hit(`RSI14 ${fmt(rsi, 2)} above ${alert.threshold}`, rsi) : NOT_TRIGGERED;
}

function rsi_below(alert, ctx) {
  const rsi = ctx.indicators?.rsi14;
  if (rsi == null || alert.threshold == null) return NOT_TRIGGERED;
  return rsi < alert.threshold ? hit(`RSI14 ${fmt(rsi, 2)} below ${alert.threshold}`, rsi) : NOT_TRIGGERED;
}

// ─── EMA ──────────────────────────────────────────────────────────────────────

function ema_bullish_cross(alert, ctx) {
  const { ema9, ema20 } = ctx.indicators || {};
  const prev = ctx.prevState || {};
  if (ema9 == null || ema20 == null || prev.ema9 == null || prev.ema20 == null) return NOT_TRIGGERED;
  if (prev.ema9 <= prev.ema20 && ema9 > ema20) {
    return hit(`EMA9 crossed above EMA20 (${fmt(ema9)} > ${fmt(ema20)})`, ema9);
  }
  return NOT_TRIGGERED;
}

function ema_bearish_cross(alert, ctx) {
  const { ema9, ema20 } = ctx.indicators || {};
  const prev = ctx.prevState || {};
  if (ema9 == null || ema20 == null || prev.ema9 == null || prev.ema20 == null) return NOT_TRIGGERED;
  if (prev.ema9 >= prev.ema20 && ema9 < ema20) {
    return hit(`EMA9 crossed below EMA20 (${fmt(ema9)} < ${fmt(ema20)})`, ema9);
  }
  return NOT_TRIGGERED;
}

function price_above_ema(alert, ctx) {
  const p = ctx.tick?.price;
  const period = alert.params?.emaPeriod === 20 ? 20 : 9;
  const ema = period === 20 ? ctx.indicators?.ema20 : ctx.indicators?.ema9;
  if (p == null || ema == null) return NOT_TRIGGERED;
  return p > ema ? hit(`Price ${fmt(p)} above EMA${period} ${fmt(ema)}`, p) : NOT_TRIGGERED;
}

function price_below_ema(alert, ctx) {
  const p = ctx.tick?.price;
  const period = alert.params?.emaPeriod === 20 ? 20 : 9;
  const ema = period === 20 ? ctx.indicators?.ema20 : ctx.indicators?.ema9;
  if (p == null || ema == null) return NOT_TRIGGERED;
  return p < ema ? hit(`Price ${fmt(p)} below EMA${period} ${fmt(ema)}`, p) : NOT_TRIGGERED;
}

// ─── VWAP ─────────────────────────────────────────────────────────────────────

function vwap_cross_up(alert, ctx) {
  const p = ctx.tick?.price;
  const vwap = ctx.indicators?.vwap;
  const prev = ctx.prevState || {};
  if (p == null || vwap == null || prev.price == null || prev.vwap == null) return NOT_TRIGGERED;
  if (prev.price <= prev.vwap && p > vwap) {
    return hit(`Price crossed above VWAP ${fmt(vwap)}`, p);
  }
  return NOT_TRIGGERED;
}

function vwap_cross_down(alert, ctx) {
  const p = ctx.tick?.price;
  const vwap = ctx.indicators?.vwap;
  const prev = ctx.prevState || {};
  if (p == null || vwap == null || prev.price == null || prev.vwap == null) return NOT_TRIGGERED;
  if (prev.price >= prev.vwap && p < vwap) {
    return hit(`Price crossed below VWAP ${fmt(vwap)}`, p);
  }
  return NOT_TRIGGERED;
}

// ─── VOLUME PROFILE ───────────────────────────────────────────────────────────

function poc_touch(alert, ctx) {
  const p = ctx.tick?.price;
  const poc = ctx.volumeProfile?.poc;
  if (p == null || poc == null) return NOT_TRIGGERED;
  if (Math.abs(p - poc) <= touchTolerance(alert, poc)) {
    return hit(`Price ${fmt(p)} touched POC ${fmt(poc)}`, p);
  }
  return NOT_TRIGGERED;
}

function poc_break(alert, ctx) {
  const p = ctx.tick?.price;
  const poc = ctx.volumeProfile?.poc;
  const prev = ctx.prevState || {};
  if (p == null || poc == null || prev.price == null) return NOT_TRIGGERED;
  const ref = prev.poc ?? poc;
  if (prev.price <= ref && p > poc) return hit(`Price broke above POC ${fmt(poc)}`, p);
  if (prev.price >= ref && p < poc) return hit(`Price broke below POC ${fmt(poc)}`, p);
  return NOT_TRIGGERED;
}

function vah_touch(alert, ctx) {
  const p = ctx.tick?.price;
  const vah = ctx.volumeProfile?.vah;
  if (p == null || vah == null) return NOT_TRIGGERED;
  if (Math.abs(p - vah) <= touchTolerance(alert, vah)) {
    return hit(`Price ${fmt(p)} touched VAH ${fmt(vah)}`, p);
  }
  return NOT_TRIGGERED;
}

function vah_break(alert, ctx) {
  const p = ctx.tick?.price;
  const vah = ctx.volumeProfile?.vah;
  const prev = ctx.prevState || {};
  if (p == null || vah == null || prev.price == null) return NOT_TRIGGERED;
  if (prev.price <= vah && p > vah) return hit(`Price broke above VAH ${fmt(vah)}`, p);
  return NOT_TRIGGERED;
}

function val_touch(alert, ctx) {
  const p = ctx.tick?.price;
  const val = ctx.volumeProfile?.val;
  if (p == null || val == null) return NOT_TRIGGERED;
  if (Math.abs(p - val) <= touchTolerance(alert, val)) {
    return hit(`Price ${fmt(p)} touched VAL ${fmt(val)}`, p);
  }
  return NOT_TRIGGERED;
}

function val_break(alert, ctx) {
  const p = ctx.tick?.price;
  const val = ctx.volumeProfile?.val;
  const prev = ctx.prevState || {};
  if (p == null || val == null || prev.price == null) return NOT_TRIGGERED;
  if (prev.price >= val && p < val) return hit(`Price broke below VAL ${fmt(val)}`, p);
  return NOT_TRIGGERED;
}

// ─── VOLUME ───────────────────────────────────────────────────────────────────

function volume_spike(alert, ctx) {
  const vol = ctx.candle?.volume;
  const avg = ctx.indicators?.volumeAvg;
  const thr = alert.threshold ?? 2.0;
  if (vol == null || avg == null || avg <= 0) return NOT_TRIGGERED;
  const ratio = vol / avg;
  return ratio >= thr ? hit(`Volume ${vol} is ${ratio.toFixed(2)}x avg (threshold ${thr}x)`, ratio) : NOT_TRIGGERED;
}

function relative_volume_spike(alert, ctx) {
  const vol = ctx.candle?.volume;
  const avg = ctx.indicators?.volumeAvg;
  const thr = alert.threshold ?? 2.0;
  if (vol == null || avg == null || avg <= 0) return NOT_TRIGGERED;
  const relVol = vol / avg;
  return relVol >= thr ? hit(`Relative volume ${relVol.toFixed(2)} >= ${thr}`, relVol) : NOT_TRIGGERED;
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

const EVALUATORS = {
  price_above, price_below, price_cross,
  rsi_above, rsi_below,
  ema_bullish_cross, ema_bearish_cross, price_above_ema, price_below_ema,
  vwap_cross_up, vwap_cross_down,
  poc_touch, poc_break, vah_touch, vah_break, val_touch, val_break,
  volume_spike, relative_volume_spike,
};

export class AlertRuleEvaluator {
  evaluate(alert, ctx) {
    const fn = EVALUATORS[alert.type];
    if (!fn) return { triggered: false, reason: `unknown type: ${alert.type}` };
    try {
      return fn(alert, ctx) || NOT_TRIGGERED;
    } catch (e) {
      return { triggered: false, reason: `eval error: ${e.message}` };
    }
  }
}

export const alertRuleEvaluator = new AlertRuleEvaluator();
