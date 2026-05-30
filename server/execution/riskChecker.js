// ── Pre-trade Risk Checker ────────────────────────────────────────────────────
//
// Enforces pre-trade risk limits before any order is routed to paper or live
// execution. Checks run in priority order: hard gates first, soft limits last.
//
// Risk check flow:
//   1. Mode gate     — live requires both env flags
//   2. Kill switch   — emergency stop
//   3. Symbol        — basic symbol validation
//   4. Quantity      — must be positive
//   5. Order value   — qty × price ≤ maxOrderValue (default $50,000)
//   6. Position size — resulting position ≤ maxPositionValue (default $100,000)
//   7. Short selling — blocked unless allowShort=true
//   8. Daily loss    — today's realized loss within limit
//   9. Concentration — single symbol ≤ 25% of gross portfolio value

import { paperTradingEngine } from '../paperTrading/paperTradingEngine.js';
import { feedManager } from '../feeds/feedManager.js';

// ── Live execution gates ──────────────────────────────────────────────────────

export function isLiveExecutionEnabled() {
  return process.env.LIVE_EXECUTION_ENABLED === 'true';
}

export function isPhase12OMSReady() {
  return process.env.IBKR_PHASE12_OMS_READY === 'true';
}

export function canGoLive() {
  return isLiveExecutionEnabled() && isPhase12OMSReady();
}

// ── Kill switch (global) ──────────────────────────────────────────────────────

let _killSwitchEnabled = false;

export function enableGlobalKillSwitch()  { _killSwitchEnabled = true; }
export function disableGlobalKillSwitch() { _killSwitchEnabled = false; }
export function isKillSwitchEnabled()     { return _killSwitchEnabled; }

// ── Risk config ───────────────────────────────────────────────────────────────

const RISK_DEFAULTS = {
  maxOrderValue:       50_000,   // USD — maximum notional per single order
  maxPositionValue:   100_000,   // USD — maximum single-symbol position value
  maxDailyLoss:        10_000,   // USD — maximum realized loss for the day
  maxConcentrationPct:     25,   // % — max single-symbol share of gross portfolio
  allowShort:           false,   // Paper mode: no naked shorts
};

function getRiskConfig() {
  return {
    maxOrderValue:       Number(process.env.MAX_ORDER_VALUE)      || RISK_DEFAULTS.maxOrderValue,
    maxPositionValue:    Number(process.env.MAX_POSITION_VALUE)   || RISK_DEFAULTS.maxPositionValue,
    maxDailyLoss:        Number(process.env.MAX_DAILY_LOSS)       || RISK_DEFAULTS.maxDailyLoss,
    maxConcentrationPct: Number(process.env.MAX_CONCENTRATION_PCT)|| RISK_DEFAULTS.maxConcentrationPct,
    allowShort:          process.env.ALLOW_SHORT === 'true',
  };
}

// ── Resolve current market price ───────────────────────────────────────────────

async function resolvePrice(symbol, requestedPrice) {
  if (requestedPrice && Number.isFinite(Number(requestedPrice))) {
    return Number(requestedPrice);
  }
  try {
    const tick = await feedManager.getLatestTick(symbol);
    if (tick?.price) return Number(tick.price);
  } catch { /* fall through */ }
  try {
    const candle = await feedManager.getLatestCandle(symbol, '1m');
    if (candle) return Number(candle.close ?? candle.c ?? 0);
  } catch { /* fall through */ }
  return 0;
}

// ── Main risk check ───────────────────────────────────────────────────────────

export async function checkPreTrade(order, mode = 'paper') {
  const cfg = getRiskConfig();

  // 1. Mode gate
  if (mode === 'live') {
    if (!isLiveExecutionEnabled()) {
      return reject('Live execution is not enabled. Set LIVE_EXECUTION_ENABLED=true to activate.', 'MODE_GATE');
    }
    if (!isPhase12OMSReady()) {
      return reject('Live go-live is blocked pending Phase 12 OMS reconciliation. Set IBKR_PHASE12_OMS_READY=true when Phase 12 is complete.', 'PHASE12_GATE');
    }
  }

  // 2. Kill switch
  if (_killSwitchEnabled) {
    return reject('Kill switch is active. All execution is blocked.', 'KILL_SWITCH');
  }

  // 3. Symbol validation
  const symbol = String(order.symbol || '').toUpperCase().trim();
  if (!symbol || symbol.length > 20 || !/^[A-Z0-9.\-=]+$/.test(symbol)) {
    return reject(`Invalid symbol: "${order.symbol}"`, 'INVALID_SYMBOL');
  }

  // 4. Quantity
  const quantity = Number(order.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return reject('Order quantity must be a positive number.', 'INVALID_QUANTITY');
  }

  // 5. Order value check
  const price = await resolvePrice(symbol, order.requestedPrice);
  const orderValue = quantity * (price || 1); // fallback to qty if no price
  if (price > 0 && orderValue > cfg.maxOrderValue) {
    return reject(
      `Order value $${orderValue.toFixed(2)} exceeds limit $${cfg.maxOrderValue.toLocaleString()}.`,
      'ORDER_VALUE_EXCEEDED',
    );
  }

  // For paper mode, use paper engine state; live mode uses same limits
  const engine = paperTradingEngine;
  const currentPos = engine.getPosition(symbol);
  const currentQty = currentPos?.quantity || 0;
  const currentAvgPrice = currentPos?.averagePrice || price || 0;

  // 6. Short selling
  const isSell = String(order.side || '').toLowerCase() === 'sell';
  if (!cfg.allowShort && isSell) {
    const wouldBeShort = (currentQty - quantity) < 0;
    if (wouldBeShort) {
      return reject('Short selling is not enabled. Order would create a short position.', 'SHORT_SELL_BLOCKED');
    }
  }

  // 7. Position size
  const projectedQty   = isSell ? currentQty - quantity : currentQty + quantity;
  const positionValue  = Math.abs(projectedQty) * (price || currentAvgPrice || 1);
  if (price > 0 && positionValue > cfg.maxPositionValue) {
    return reject(
      `Projected position value $${positionValue.toFixed(2)} exceeds limit $${cfg.maxPositionValue.toLocaleString()}.`,
      'POSITION_SIZE_EXCEEDED',
    );
  }

  // 8. Daily loss check
  const todayLoss = Math.max(0, -engine.totalRealizedPnL());
  if (todayLoss >= cfg.maxDailyLoss) {
    return reject(
      `Daily loss limit $${cfg.maxDailyLoss.toLocaleString()} reached (current: $${todayLoss.toFixed(2)}).`,
      'DAILY_LOSS_LIMIT',
    );
  }

  // 9. Concentration check
  const allPositions = engine.getPositions();
  const grossValue = allPositions.reduce((s, p) => s + Math.abs((p.marketPrice || p.averagePrice) * p.quantity), 0);
  if (grossValue > 0 && price > 0) {
    const newExposure = (currentPos ? Math.abs(projectedQty) : quantity) * price;
    const concentrationPct = (newExposure / (grossValue + orderValue)) * 100;
    if (concentrationPct > cfg.maxConcentrationPct) {
      return reject(
        `Concentration in ${symbol} would be ${concentrationPct.toFixed(1)}%, exceeding ${cfg.maxConcentrationPct}% limit.`,
        'CONCENTRATION_EXCEEDED',
      );
    }
  }

  return {
    allowed: true,
    reason: 'Pre-trade risk checks passed.',
    code: 'APPROVED',
    arrivalPrice: price,
    config: cfg,
  };
}

function reject(reason, code) {
  return { allowed: false, reason, code };
}

export function getRiskStatus() {
  return {
    killSwitch:             _killSwitchEnabled,
    liveExecutionEnabled:   isLiveExecutionEnabled(),
    phase12OMSReady:        isPhase12OMSReady(),
    canGoLive:              canGoLive(),
    config:                 getRiskConfig(),
    mode:                   canGoLive() ? 'live_ready' : 'paper_only',
  };
}
