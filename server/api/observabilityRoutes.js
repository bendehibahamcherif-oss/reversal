import { Router } from 'express';
import { metricsStore }        from '../observability/metrics.js';
import { getMarketSessionState } from '../observability/marketSession.js';
import { getWsStats }           from '../websocket/wsEmitter.js';
import { feedManager }          from '../feeds/feedManager.js';

const obsRoutes = Router();

// ── Health ────────────────────────────────────────────────────────────────────

// GET /api/observability/health
// Returns structured health document: uptime, memory, feed state, market session.
obsRoutes.get('/health', (req, res) => {
  const mem     = process.memoryUsage();
  const metrics = metricsStore.getSummary();
  const session = getMarketSessionState();
  const ws      = getWsStats();

  return res.json({
    ok:          true,
    service:     process.env.SERVICE_NAME || 'reversal-api',
    timestamp:   new Date().toISOString(),
    traceId:     req.traceId || null,
    uptime: {
      secs:      metrics.uptimeSecs,
      startedAt: metrics.startedAt,
    },
    memory: {
      heapUsedMB:  Number((mem.heapUsed  / 1_048_576).toFixed(1)),
      heapTotalMB: Number((mem.heapTotal / 1_048_576).toFixed(1)),
      rssMB:       Number((mem.rss       / 1_048_576).toFixed(1)),
    },
    requests: {
      total:      metrics.totalRequests,
      errors:     metrics.totalErrors,
      errorPct:   metrics.globalErrorPct,
    },
    marketSession: {
      isOpen:   session.isOpen,
      session:  session.session,
      etTime:   session.etTime,
      override: session.overrideActive,
    },
    websocket: {
      connectedClients: ws.connectedClients,
      adapterType:      ws.adapterType,
    },
    rateLimit: {
      max:     Number(process.env.RATE_LIMIT_MAX) || 100,
      strictMax: Number(process.env.RATE_LIMIT_STRICT_MAX) || 20,
    },
  });
});

// ── Metrics ───────────────────────────────────────────────────────────────────

// GET /api/observability/metrics
// Full per-route latency + error-rate breakdown.
obsRoutes.get('/metrics', (_req, res) => {
  return res.json({ ok: true, ...metricsStore.getSummary() });
});

// POST /api/observability/metrics/reset  (diagnostic use only)
obsRoutes.post('/metrics/reset', (_req, res) => {
  metricsStore.reset();
  return res.json({ ok: true, message: 'Metrics reset.' });
});

// ── Market session ────────────────────────────────────────────────────────────

// GET /api/observability/market-session
obsRoutes.get('/market-session', (_req, res) => {
  return res.json({ ok: true, ...getMarketSessionState() });
});

// ── WebSocket stats ───────────────────────────────────────────────────────────

// GET /api/observability/websocket-stats
// Current connection count + Redis adapter upgrade path.
obsRoutes.get('/websocket-stats', (_req, res) => {
  return res.json({ ok: true, ...getWsStats() });
});

// ── Provider failover drill ───────────────────────────────────────────────────
//
// POST /api/observability/failover-drill
//
// Non-destructive drill that verifies the provider fallback chain works:
//   1. Records the current active provider order.
//   2. Attempts a candle fetch with a synthetic symbol to force fallback.
//   3. Verifies fallback_demo returns synthetic data successfully.
//   4. Reports provider health and timing.
//
// The drill NEVER mutates the active provider configuration.

obsRoutes.post('/failover-drill', async (_req, res) => {
  const drillStartMs = Date.now();
  const DRILL_SYMBOL = 'DRILL_TEST_SYMBOL';

  const steps = [];

  // Step 1: capture current provider chain
  const providerState = feedManager.getActiveProviders();
  steps.push({
    step:          1,
    action:        'capture_provider_chain',
    providerOrder: providerState.providerOrder,
    ok:            true,
  });

  // Step 2: attempt fetch with synthetic symbol → forces fallback_demo
  let fallbackOk = false;
  let fallbackSource = null;
  let fallbackCandleCount = 0;
  const fetchStart = Date.now();
  try {
    const result = await feedManager.getReplayCandles(DRILL_SYMBOL, '1d', 10);
    fallbackSource       = result?.source || 'unknown';
    fallbackCandleCount  = Array.isArray(result?.candles) ? result.candles.length : 0;
    fallbackOk           = fallbackSource === 'fallback_demo' || fallbackCandleCount > 0;
    steps.push({
      step:         2,
      action:       'force_fallback_via_synthetic_symbol',
      source:       fallbackSource,
      candleCount:  fallbackCandleCount,
      fetchMs:      Date.now() - fetchStart,
      ok:           fallbackOk,
      note:         fallbackOk
        ? 'Fallback data source responded correctly.'
        : 'Fallback returned no candles — check fallback_demo provider.',
    });
  } catch (err) {
    steps.push({
      step:   2,
      action: 'force_fallback_via_synthetic_symbol',
      ok:     false,
      error:  err.message,
    });
  }

  // Step 3: check primary providers health
  const statuses     = feedManager.getFeedStatus();
  const primaryOk    = statuses.some((s) => s.connected === true);
  steps.push({
    step:            3,
    action:          'check_primary_provider_health',
    providerStatuses: statuses.map((s) => ({ provider: s.provider || s.source, connected: s.connected })),
    anyLiveConnected: primaryOk,
    ok:              true,
    note:            primaryOk
      ? 'At least one primary provider is connected.'
      : 'No primary provider connected — running on fallback_demo.',
  });

  const totalMs   = Date.now() - drillStartMs;
  const drillPass = fallbackOk;

  return res.json({
    ok:           drillPass,
    drillPass,
    totalMs,
    timestamp:    new Date().toISOString(),
    providerOrder: providerState.providerOrder,
    fallbackSource,
    fallbackCandleCount,
    steps,
    summary: drillPass
      ? 'Failover drill passed: fallback_demo is reachable and returns synthetic candles.'
      : 'Failover drill FAILED: fallback_demo did not return usable data.',
    documentation: {
      fallbackChain:   'Primary providers → fallback_demo (synthetic OHLCV)',
      fallbackBehavior: 'When all real providers fail, fallback_demo generates seeded synthetic candles.',
      configuredVia:   'POST /api/feeds/providers/active to change provider order.',
      fallbackStates: [
        { state: 'yahoo_ok',       description: 'Yahoo Finance is primary, returns live daily candles.' },
        { state: 'yahoo_down',     description: 'Yahoo returns empty or stale; fallback_demo activates.' },
        { state: 'all_down',       description: 'All real providers fail; fallback_demo provides synthetic data.' },
        { state: 'fallback_demo',  description: 'Always available; uses seeded random walk from historicalStore.' },
      ],
    },
  });
});

// ── Rate-limit diagnostics ────────────────────────────────────────────────────

// GET /api/observability/rate-limit-status
obsRoutes.get('/rate-limit-status', (req, res) => {
  return res.json({
    ok:           true,
    globalMax:    Number(process.env.RATE_LIMIT_MAX)        || 100,
    strictMax:    Number(process.env.RATE_LIMIT_STRICT_MAX) || 20,
    windowMs:     60000,
    headers: {
      limit:     req.headers['x-ratelimit-limit']     || res.getHeader('X-RateLimit-Limit')     || null,
      remaining: req.headers['x-ratelimit-remaining'] || res.getHeader('X-RateLimit-Remaining') || null,
      reset:     req.headers['x-ratelimit-reset']     || res.getHeader('X-RateLimit-Reset')     || null,
    },
    note: 'X-RateLimit-* headers are set on every response by the global rate limiter.',
  });
});

export default obsRoutes;
