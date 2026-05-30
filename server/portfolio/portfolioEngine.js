import { paperTradingEngine } from '../paperTrading/paperTradingEngine.js';
import { feedManager } from '../feeds/feedManager.js';

const PRICE_STALENESS_MS = 60_000;

// ── Fresh price resolution ────────────────────────────────────────────────────

async function resolvePrice(symbol) {
  let price = null;
  let fresh = false;
  let source = 'unknown';

  try {
    const tick = await feedManager.getLatestTick(symbol);
    if (tick && tick.price) {
      price = Number(tick.price);
      source = tick.source || 'feed';
      const ageMs = Date.now() - (tick.timestamp ? new Date(tick.timestamp).getTime() : 0);
      fresh = ageMs < PRICE_STALENESS_MS;
    }
  } catch {
    // fall through to candle fallback
  }

  if (!price) {
    try {
      const candle = await feedManager.getLatestCandle(symbol, '1m');
      if (candle && (candle.close ?? candle.c)) {
        price = Number(candle.close ?? candle.c);
        source = candle.source || 'candle_fallback';
        fresh = false;
      }
    } catch {
      // no price available
    }
  }

  return { price, fresh, source };
}

// ── Positions with refreshed market prices ────────────────────────────────────

async function getPositionsWithPnL(engine) {
  const positions = engine.getPositions();
  const enriched = await Promise.all(
    positions.map(async (pos) => {
      const { price, fresh, source } = await resolvePrice(pos.symbol);
      const marketPrice = price ?? pos.marketPrice ?? pos.averagePrice ?? 0;
      const unrealizedPnL = Number(((marketPrice - pos.averagePrice) * pos.quantity).toFixed(6));
      return {
        ...pos,
        marketPrice,
        unrealizedPnL,
        priceFresh: fresh,
        priceSource: source,
      };
    }),
  );
  return enriched;
}

// ── Exposure metrics ──────────────────────────────────────────────────────────

function computeExposure(positions) {
  let longExposure  = 0;
  let shortExposure = 0;

  for (const pos of positions) {
    if (pos.quantity === 0) continue;
    const mv = pos.marketPrice * Math.abs(pos.quantity);
    if (pos.quantity > 0) longExposure  += mv;
    else                   shortExposure += mv;
  }

  return {
    gross: Number((longExposure + shortExposure).toFixed(4)),
    net:   Number((longExposure - shortExposure).toFixed(4)),
    long:  Number(longExposure.toFixed(4)),
    short: Number(shortExposure.toFixed(4)),
  };
}

// ── Equity curve and drawdown ─────────────────────────────────────────────────

function buildEquityCurve(fills) {
  if (!fills.length) return [];

  const sorted = [...fills].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let equity = 0;
  const curve = [];

  for (const fill of sorted) {
    const signedQty = fill.side === 'buy' ? -fill.quantity : fill.quantity;
    equity += signedQty * fill.price;
    curve.push({ timestamp: fill.timestamp, equity: Number(equity.toFixed(4)) });
  }

  return curve;
}

function computeDrawdownSeries(fills) {
  const curve = buildEquityCurve(fills);
  if (!curve.length) return { series: [], maxDrawdown: 0, maxDrawdownPct: 0 };

  let peak = -Infinity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const series = curve.map(({ timestamp, equity }) => {
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? peak - equity : 0;
    const drawdownPct = peak > 0 ? Number(((drawdown / peak) * 100).toFixed(4)) : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = drawdownPct;
    }
    return { timestamp, equity, peak: Number(peak.toFixed(4)), drawdown: Number(drawdown.toFixed(4)), drawdownPct };
  });

  return {
    series,
    maxDrawdown:    Number(maxDrawdown.toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
  };
}

// ── VaR (parametric, normal distribution) ─────────────────────────────────────
// Uses historical fill PnL changes to estimate daily volatility, then scales
// to requested horizon via sqrt(T). Confidence Z-scores: 0.90→1.282, 0.95→1.645, 0.99→2.326.

const Z_SCORE = { 0.90: 1.2816, 0.95: 1.6449, 0.99: 2.3263 };

function computeVaR(fills, portfolioValue, confidence = 0.95, horizon = 1) {
  if (!fills.length || portfolioValue === 0) {
    return { var: 0, varPct: 0, confidence, horizon, method: 'parametric_normal', dataPoints: 0 };
  }

  const sorted = [...fills].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Build daily PnL series
  const dailyPnL = new Map();
  for (const fill of sorted) {
    const day = fill.timestamp.slice(0, 10);
    const pnl = fill.side === 'sell'
      ? (fill.price * fill.quantity)
      : -(fill.price * fill.quantity);
    dailyPnL.set(day, (dailyPnL.get(day) || 0) + pnl);
  }

  const pnlValues = Array.from(dailyPnL.values());
  if (pnlValues.length < 2) {
    return { var: 0, varPct: 0, confidence, horizon, method: 'parametric_normal', dataPoints: pnlValues.length, warning: 'Insufficient data for VaR estimation (need ≥2 trading days)' };
  }

  const mean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
  const variance = pnlValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnlValues.length - 1);
  const stdDev = Math.sqrt(variance);

  const z = Z_SCORE[confidence] ?? Z_SCORE[0.95];
  const varValue = (mean - z * stdDev) * Math.sqrt(horizon);
  const varLoss  = Math.max(0, -varValue);

  return {
    var:        Number(varLoss.toFixed(4)),
    varPct:     portfolioValue > 0 ? Number(((varLoss / portfolioValue) * 100).toFixed(4)) : 0,
    confidence,
    horizon,
    method:     'parametric_normal',
    dataPoints: pnlValues.length,
    stdDev:     Number(stdDev.toFixed(4)),
    meanDailyPnL: Number(mean.toFixed(4)),
  };
}

// ── Stress test ───────────────────────────────────────────────────────────────

function runStressTest(positions, scenarios) {
  return scenarios.map((scenario) => {
    const shocks = scenario.shocks || {};
    let pnlImpact = 0;

    const details = positions
      .filter((pos) => pos.quantity !== 0)
      .map((pos) => {
        const shock = shocks[pos.symbol] ?? shocks['*'] ?? 0;
        const shockedPrice = pos.marketPrice * (1 + shock);
        const impact = (shockedPrice - pos.marketPrice) * pos.quantity;
        pnlImpact += impact;
        return {
          symbol:       pos.symbol,
          quantity:     pos.quantity,
          currentPrice: pos.marketPrice,
          shockedPrice: Number(shockedPrice.toFixed(6)),
          shock,
          impact:       Number(impact.toFixed(4)),
        };
      });

    return {
      name:           scenario.name || 'Unnamed Scenario',
      pnlImpact:      Number(pnlImpact.toFixed(4)),
      pnlImpactPct:   0, // filled below with portfolio value context
      details,
    };
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export const portfolioEngine = {
  async getPositions(mode) {
    if (mode !== 'paper') return { error: 'live mode not connected', code: 503 };
    const positions = await getPositionsWithPnL(paperTradingEngine);
    return { positions, mode: 'paper', modeBadge: 'PAPER' };
  },

  async getSummary(mode) {
    if (mode !== 'paper') return { error: 'live mode not connected', code: 503 };

    const positions  = await getPositionsWithPnL(paperTradingEngine);
    const exposure   = computeExposure(positions);
    const openPositions = positions.filter((p) => p.quantity !== 0);

    const totalRealizedPnL   = Number(paperTradingEngine.totalRealizedPnL().toFixed(4));
    const totalUnrealizedPnL = Number(positions.reduce((s, p) => s + (p.unrealizedPnL || 0), 0).toFixed(4));
    const totalPnL           = Number((totalRealizedPnL + totalUnrealizedPnL).toFixed(4));

    const allPriceFresh = openPositions.every((p) => p.priceFresh);

    return {
      mode:               'paper',
      modeBadge:          'PAPER',
      positionCount:      openPositions.length,
      exposure,
      totalRealizedPnL,
      totalUnrealizedPnL,
      totalPnL,
      pricesFresh:        allPriceFresh,
      pricesAsOf:         new Date().toISOString(),
      positions:          openPositions,
    };
  },

  getDrawdown(mode) {
    if (mode !== 'paper') return { error: 'live mode not connected', code: 503 };
    const fills = paperTradingEngine.getFills();
    return { ...computeDrawdownSeries(fills), mode: 'paper', modeBadge: 'PAPER', fillCount: fills.length };
  },

  async getVaR(mode, confidence, horizon) {
    if (mode !== 'paper') return { error: 'live mode not connected', code: 503 };
    const fills     = paperTradingEngine.getFills();
    const positions = await getPositionsWithPnL(paperTradingEngine);
    const exposure  = computeExposure(positions);
    const portfolioValue = exposure.gross;
    const result = computeVaR(fills, portfolioValue, confidence, horizon);
    return { ...result, mode: 'paper', modeBadge: 'PAPER' };
  },

  async runStressTest(mode, scenarios) {
    if (mode !== 'paper') return { error: 'live mode not connected', code: 503 };
    const positions = await getPositionsWithPnL(paperTradingEngine);
    const exposure  = computeExposure(positions);
    const portfolioValue = exposure.gross;

    const results = runStressTest(positions, scenarios).map((r) => ({
      ...r,
      pnlImpactPct: portfolioValue > 0
        ? Number(((r.pnlImpact / portfolioValue) * 100).toFixed(4))
        : 0,
    }));

    return {
      mode:           'paper',
      modeBadge:      'PAPER',
      portfolioValue: Number(portfolioValue.toFixed(4)),
      scenarios:      results,
    };
  },
};
