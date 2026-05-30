// ── Execution Quality Analytics ───────────────────────────────────────────────
//
// Computes execution quality metrics from the fills stored in executionStore:
//
//   Slippage (bps) = (fillPrice - arrivalPrice) / arrivalPrice × 10000
//     Positive slippage on buy  = worse than arrival (paid more)
//     Negative slippage on buy  = better than arrival (market moved favorably)
//
//   Fill rate (%) = filled orders / (filled + rejected + canceled) × 100
//
//   Benchmark = market price at order arrival time (arrivalPrice field)

import { executionStore } from './executionStore.js';

export const executionAnalytics = {
  // Compute aggregate execution quality for the given filter
  compute({ symbol, mode, limit = 500 } = {}) {
    const orders = executionStore.getOrders({ symbol, mode, limit });
    const fills  = executionStore.getFills({ symbol, mode, limit });

    if (!orders.length) {
      return { ok: true, sampleCount: 0, fillRate: 0, avgSlippageBps: 0, totalCommissions: 0, fills: [], warnings: ['No execution data available.'] };
    }

    const filledOrders   = orders.filter((o) => o.status === 'filled');
    const rejectedOrders = orders.filter((o) => o.status === 'rejected');
    const canceledOrders = orders.filter((o) => o.status === 'canceled');
    const denominator    = filledOrders.length + rejectedOrders.length + canceledOrders.length;
    const fillRate       = denominator > 0 ? (filledOrders.length / denominator) * 100 : 0;

    // Slippage per fill (in bps)
    const slippageValues = fills
      .map((f) => {
        const order = orders.find((o) => o.orderId === f.orderId);
        const arrival = order?.arrivalPrice;
        if (!arrival || !f.price || arrival === 0) return null;
        const bps = ((f.price - arrival) / arrival) * 10_000;
        // Flip sign for sells: positive = worse execution
        return order?.side === 'sell' ? -bps : bps;
      })
      .filter((v) => v !== null && Number.isFinite(v));

    const avgSlippageBps = slippageValues.length
      ? Number((slippageValues.reduce((s, v) => s + v, 0) / slippageValues.length).toFixed(4))
      : 0;

    const totalCommissions = fills.reduce((s, f) => s + Number(f.commissions || 0), 0);
    const totalNotional    = fills.reduce((s, f) => s + f.price * f.quantity, 0);

    // Per-symbol breakdown
    const bySymbol = {};
    for (const f of fills) {
      const sym = f.symbol;
      if (!bySymbol[sym]) bySymbol[sym] = { fills: 0, notional: 0, commissions: 0, slippageBpsSum: 0 };
      bySymbol[sym].fills++;
      bySymbol[sym].notional    += f.price * f.quantity;
      bySymbol[sym].commissions += Number(f.commissions || 0);
      bySymbol[sym].slippageBpsSum += Number(f.slippageBps || 0);
    }
    const symbolBreakdown = Object.entries(bySymbol).map(([sym, d]) => ({
      symbol: sym,
      fillCount:       d.fills,
      notional:        Number(d.notional.toFixed(2)),
      commissions:     Number(d.commissions.toFixed(4)),
      avgSlippageBps:  Number((d.slippageBpsSum / d.fills).toFixed(4)),
    }));

    return {
      ok:                 true,
      sampleCount:        orders.length,
      filledCount:        filledOrders.length,
      rejectedCount:      rejectedOrders.length,
      canceledCount:      canceledOrders.length,
      fillRate:           Number(fillRate.toFixed(2)),
      avgSlippageBps,
      totalCommissions:   Number(totalCommissions.toFixed(4)),
      totalNotional:      Number(totalNotional.toFixed(2)),
      symbolBreakdown,
      fills:              fills.slice(0, 50),
      warnings:           [],
    };
  },
};
