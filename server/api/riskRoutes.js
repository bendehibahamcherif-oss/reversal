/**
 * riskRoutes.js
 *
 * Express Router — Risk Analytics
 * Mounted at /api/risk
 *
 * Aggregates risk data from portfolioEngine (paper mode).
 * All endpoints degrade gracefully: empty positions → empty/zero state, never 404.
 */

import { Router } from 'express';
import { portfolioEngine } from '../portfolio/portfolioEngine.js';

const riskRoutes = Router();

function parseMode(req) {
  return String(req.query.mode || 'paper').toLowerCase();
}

// ── GET /api/risk/summary ────────────────────────────────────────────────────
//
// Aggregated risk snapshot: exposure + drawdown + VaR in one call.

riskRoutes.get('/summary', async (req, res) => {
  const mode = parseMode(req);
  try {
    const [summary, drawdownResult, varResult] = await Promise.all([
      portfolioEngine.getSummary(mode),
      Promise.resolve(portfolioEngine.getDrawdown(mode)),
      portfolioEngine.getVaR(mode, 0.95, 1),
    ]);

    if (summary.error && summary.code) {
      return res.status(summary.code).json({ ok: false, error: summary.error, mode });
    }

    const exp = summary.exposure ?? {};
    return res.json({
      ok:   true,
      mode,
      risk: {
        var95:              varResult.error  ? null : (varResult.var        ?? 0),
        var95Pct:           varResult.error  ? null : (varResult.varPct     ?? 0),
        expectedShortfall:  null,
        grossExposure:      Number(exp.gross  ?? 0),
        netExposure:        Number(exp.net    ?? 0),
        longExposure:       Number(exp.long   ?? 0),
        shortExposure:      Number(exp.short  ?? 0),
        leverage:           Number(exp.leverage ?? 0),
        maxDrawdown:        drawdownResult.error ? 0 : Number(drawdownResult.maxDrawdown    ?? 0),
        maxDrawdownPct:     drawdownResult.error ? 0 : Number(drawdownResult.maxDrawdownPct ?? 0),
        totalPnL:           Number(summary.totalPnL           ?? 0),
        realizedPnL:        Number(summary.totalRealizedPnL   ?? 0),
        unrealizedPnL:      Number(summary.totalUnrealizedPnL ?? 0),
        positionCount:      Number(summary.positionCount      ?? 0),
        status:             summary.positionCount > 0 ? 'active' : 'not_enough_data',
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, code: 'RISK_SUMMARY_ERROR' });
  }
});

// ── GET /api/risk/exposure ───────────────────────────────────────────────────

riskRoutes.get('/exposure', async (req, res) => {
  const mode = parseMode(req);
  try {
    const result = await portfolioEngine.getSummary(mode);
    if (result.error && result.code) {
      return res.status(result.code).json({ ok: false, error: result.error, mode });
    }
    const exp = result.exposure ?? {};
    return res.json({
      ok: true,
      mode,
      exposure: {
        gross:    Number(exp.gross    ?? 0),
        net:      Number(exp.net      ?? 0),
        long:     Number(exp.long     ?? 0),
        short:    Number(exp.short    ?? 0),
        leverage: Number(exp.leverage ?? 0),
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/risk/drawdown ───────────────────────────────────────────────────

riskRoutes.get('/drawdown', (req, res) => {
  const mode = parseMode(req);
  try {
    const result = portfolioEngine.getDrawdown(mode);
    if (result.error && result.code) {
      return res.status(result.code).json({ ok: false, error: result.error, mode });
    }
    const series = Array.isArray(result.series)
      ? result.series.map((s) => (typeof s === 'object' ? Number(s.drawdownPct ?? s.drawdown ?? 0) : Number(s)))
      : [];
    return res.json({
      ok:   true,
      mode,
      drawdown: {
        series,
        currentDrawdown: series.length ? series[series.length - 1] : 0,
        maxDrawdown:     Number(result.maxDrawdown    ?? 0),
        maxDrawdownPct:  Number(result.maxDrawdownPct ?? 0),
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/risk/var ────────────────────────────────────────────────────────

riskRoutes.get('/var', async (req, res) => {
  const mode       = parseMode(req);
  const confidence = Math.min(0.99, Math.max(0.90, parseFloat(req.query.confidence) || 0.95));
  const horizon    = Math.min(30,   Math.max(1,    parseInt(req.query.horizon, 10)   || 1));
  try {
    const result = await portfolioEngine.getVaR(mode, confidence, horizon);
    if (result.error && result.code) {
      return res.status(result.code).json({ ok: false, error: result.error, mode });
    }
    return res.json({ ok: true, mode, ...result });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/risk/limits ─────────────────────────────────────────────────────
//
// Static risk limits — no limit engine yet. Returns configured defaults.

riskRoutes.get('/limits', (_req, res) => {
  return res.json({
    ok: true,
    limits: {
      maxPositionSize:    null,
      maxGrossExposure:   null,
      maxNetExposure:     null,
      maxDrawdownPct:     null,
      maxVaR95:           null,
      killSwitchActive:   false,
      status:             'not_configured',
      message:            'Risk limits not yet configured for this account.',
    },
  });
});

// ── GET /api/risk/alerts ─────────────────────────────────────────────────────
//
// Risk-level alerts derived from current exposure/drawdown state.

riskRoutes.get('/alerts', async (req, res) => {
  const mode = parseMode(req);
  try {
    const result = await portfolioEngine.getSummary(mode);
    if (result.error && result.code) {
      return res.status(result.code).json({ ok: false, error: result.error, mode });
    }
    // No active risk alert rules yet — return empty
    return res.json({ ok: true, mode, alerts: [], count: 0 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default riskRoutes;
