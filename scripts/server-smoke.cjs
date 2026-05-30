const { spawn } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT || 19090);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const checks = [
  { method: 'GET', path: '/api/runtime/health' },
  { method: 'GET', path: '/api/runtime/runtime-status' },
  { method: 'GET', path: '/api/monitoring/runtime-status' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=1m' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=5m' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=15m' },
  { method: 'GET', path: '/api/replay-legacy/candles/SPY?timeframe=1H' },
  { method: 'POST', path: '/api/replay-session/start' },
  { method: 'POST', path: '/api/replay-session/pause' },
  { method: 'POST', path: '/api/replay-session/resume' },
  { method: 'POST', path: '/api/replay-session/stop' },
  { method: 'GET', path: '/api/alpha/signals/SPY' },
  { method: 'POST', path: '/api/alpha/analyze/SPY' },
  { method: 'GET', path: '/api/patterns/signals/SPY' },
  { method: 'POST', path: '/api/patterns/analyze/SPY' },
  { method: 'GET', path: '/api/strategies/candidates/SPY' },
  { method: 'POST', path: '/api/strategies/generate/SPY' },
  { method: 'GET', path: '/api/quant/features/SPY' },
  { method: 'GET', path: '/api/quality/scores/SPY' },
  { method: 'POST', path: '/api/quality/score/SPY' },
  { method: 'POST', path: '/api/quant/extract/SPY' },
  { method: 'GET', path: '/api/quant/pipeline/SPY' },
  { method: 'POST', path: '/api/quant/pipeline/SPY' },
  { method: 'GET', path: '/api/analytics/trend/SPY' },
  { method: 'GET', path: '/api/analytics/latest/SPY' },
  { method: 'POST', path: '/api/backtest/run/SPY' },
  { method: 'GET', path: '/api/backtest/results/SPY' },
  { method: 'GET', path: '/api/backtest/runs/SPY' },
  { method: 'POST', path: '/api/backtest/walk-forward/SPY', body: { timeframe: '1m', options: { trainRatio: 0.6, testRatio: 0.2, stepRatio: 0.1, minTestCandles: 5 } } },
  { method: 'GET', path: '/api/backtest/walk-forward/SPY' },
  { method: 'POST', path: '/api/validation/strategy/SPY' },
  { method: 'GET', path: '/api/validation/results/SPY' },
  { method: 'POST', path: '/api/strategy-lab/save/SPY', body: { name: 'Smoke Manual Save', type: 'manual', direction: 'long', timeframe: '1h', entryLogic: 'Breakout above VWAP', exitLogic: 'Trailing stop below EMA', riskRules: { maxRiskPct: 1 }, notes: 'Smoke check manual save route', tags: ['smoke', 'manual'] } },
  { method: 'POST', path: '/api/strategy-lab/strategies/SPY', body: { name: 'Smoke Alias Save', type: 'manual', direction: 'short', timeframe: '15m', entryLogic: 'Reversal at resistance', exitLogic: 'Take profit at support', riskRules: { maxRiskPct: 0.5 }, notes: 'Smoke check alias route', tags: ['smoke', 'alias'] } },
  { method: 'GET', path: '/api/strategy-lab/strategies/SPY' },
  { method: 'GET', path: '/api/rules/sets/SPY' },
  { method: 'GET', path: '/api/templates/strategies' },
  { method: 'GET', path: '/api/session-context/SPY' },
  { method: 'POST', path: '/api/session-context/compute/SPY' },
  { method: 'GET', path: '/api/reversals/points/SPY' },
  { method: 'POST', path: '/api/reversals/detect/SPY' },
  { method: 'POST', path: '/api/templates/strategies/opening-gap-contrarian-reversal/create-rule-set', body: { symbol: 'SPY', overrides: { timeframe: '5m' } } },
  { method: 'POST', path: '/api/rules/set/SPY', body: { name: 'Smoke Rule Set', description: 'Safe smoke rule set only for deterministic backend checks.', timeframe: '1h', status: 'draft', tags: ['smoke','rules'], conditions: [{ field: 'score', operator: '>=', value: 0, source: 'qualityScore', timeframe: '1h', enabled: true }], actions: [{ type: 'entry_exit', direction: 'long', entryLogic: 'Enter only if rule condition passes in research mode.', exitLogic: 'Exit if rule fails on reevaluation.', stopLossLogic: 'Use protective stop.', takeProfitLogic: 'Use conservative take profit.', invalidationCondition: 'Invalidate when condition fails.', riskRules: { maxRiskPerTrade: 0.005 } }], riskRules: { maxDailyRisk: 0.01 } } },
  { method: 'GET', path: '/api/paper/risk/status' },
  { method: 'POST', path: '/api/paper/orders', body: { symbol: 'SPY', side: 'buy', type: 'market', quantity: 1, requestedPrice: 500.25, strategyId: 'smoke-paper', source: 'smoke_test' } },
  { method: 'GET', path: '/api/paper/orders/SPY' },
  { method: 'GET', path: '/api/paper/positions' },
  { method: 'POST', path: '/api/paper/reset' },
  { method: 'GET', path: '/api/feeds/status' },
  { method: 'GET', path: '/api/feeds/providers' },
  { method: 'POST', path: '/api/feeds/providers/active', body: { providers: ['fallback_demo', 'yahoo'], symbols: ['SPY', 'QQQ'] } },
  { method: 'GET', path: '/api/feeds/providers/active' },
  { method: 'POST', path: '/api/feeds/providers/polygon/credentials', body: { apiKey: 'fake_polygon_key_12345' } },
  { method: 'GET', path: '/api/feeds/providers/polygon' },
  { method: 'DELETE', path: '/api/feeds/providers/polygon/credentials' },
  { method: 'POST', path: '/api/feeds/demo/tick/SPY' },
  { method: 'GET', path: '/api/feeds/tick/SPY' },
  { method: 'POST', path: '/api/feeds/demo/candle/SPY' },
  { method: 'GET', path: '/api/feeds/candle/SPY?timeframe=1m' },
  // ── Alert engine ────────────────────────────────────────────────────────────
  { method: 'GET',  path: '/api/alerts' },
  { method: 'GET',  path: '/api/alerts/diagnostics' },
  { method: 'GET',  path: '/api/alerts/history' },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'price_above',          threshold: 10000, cooldownMode: 'cooldown_minutes', cooldownMinutes: 60 } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'rsi_below',             threshold: 30,    cooldownMode: 'cooldown_minutes', cooldownMinutes: 60 } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'ema_bullish_cross',                       cooldownMode: 'always' } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'vwap_cross_up',                           cooldownMode: 'once' } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'poc_touch',                               cooldownMode: 'cooldown_minutes', cooldownMinutes: 30 } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'vah_break',                               cooldownMode: 'cooldown_minutes', cooldownMinutes: 30 } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'val_break',                               cooldownMode: 'cooldown_minutes', cooldownMinutes: 30 } },
  { method: 'POST', path: '/api/alerts', body: { symbol: 'SPY', type: 'volume_spike',          threshold: 3.0,   cooldownMode: 'cooldown_minutes', cooldownMinutes: 60 } },
  { method: 'GET',  path: '/api/alerts?symbol=SPY' },
  // ── Volume Profile ───────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/volume-profile/SPY?mode=visible_range&bins=50' },
  { method: 'GET', path: '/api/volume-profile/SPY?mode=daily&bins=50' },
  { method: 'GET', path: '/api/volume-profile/SPY?mode=session&bins=100' },
  { method: 'GET', path: '/api/volume-profile/BTC-USD?mode=visible_range&bins=200' },
  { method: 'GET', path: '/api/volume-profile/EURUSD%3DX?mode=visible_range&bins=50' },
  // ── Chart ────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/chart/candles/SPY?timeframe=1m&limit=50' },
  { method: 'GET', path: '/api/chart/indicators/SPY?timeframe=1m' },
  { method: 'GET', path: '/api/chart/overlays/SPY?timeframe=1m' },
  { method: 'GET', path: '/api/chart/orderflow/SPY' },
  { method: 'GET', path: '/api/chart/payload/SPY?timeframe=1m&limit=50' },
  // ── CVD ─────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/chart/cvd/SPY?timeframe=1m&limit=50', _cvdCheck: true },
  { method: 'GET', path: '/api/chart/cvd/BTC-USD?timeframe=1m&limit=50', _cvdCheck: true },
  // ── Footprint ────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/api/chart/footprint/SPY?timeframe=1m&limit=20', _fpCheck: true },
  { method: 'GET', path: '/api/chart/footprint/SPY?timeframe=1m&limit=10&clusterSize=0.25&imbalanceThreshold=3', _fpCheck: true },
  { method: 'GET', path: '/api/chart/footprint/BTC-USD?timeframe=1m&limit=10', _fpCheck: true },
  // ── Portfolio ────────────────────────────────────────────────────────────────
  { method: 'GET',  path: '/api/portfolio/positions?mode=paper', _portfolioCheck: true },
  { method: 'GET',  path: '/api/portfolio/summary?mode=paper',   _portfolioCheck: true },
  { method: 'GET',  path: '/api/portfolio/drawdown?mode=paper',  _portfolioCheck: true },
  { method: 'GET',  path: '/api/portfolio/var?mode=paper&confidence=0.95&horizon=1', _portfolioVarCheck: true },
  { method: 'POST', path: '/api/portfolio/stress-test?mode=paper', body: { scenarios: [{ name: 'Market Crash -10%', shocks: { '*': -0.10 } }, { name: 'Tech Rally +5%', shocks: { SPY: 0.05 } }] }, _portfolioStressCheck: true },
  { method: 'GET',  path: '/api/portfolio/summary?mode=live', _portfolioLiveCheck: true },
  { method: 'POST', path: '/api/ai/features/save/SPY' },
  { method: 'GET', path: '/api/ai/features/SPY' },
  { method: 'POST', path: '/api/ai/labels/symbol/SPY' },
  { method: 'GET', path: '/api/ai/labels/SPY' },
  { method: 'GET', path: '/api/ai/regime/SPY' },
  { method: 'POST', path: '/api/ai/analytics/analyze/SPY' },
  { method: 'GET', path: '/api/ai/analytics/SPY' },
  { method: 'GET', path: '/api/ai/analytics/features/SPY' },
  { method: 'GET', path: '/api/ai/analytics/regimes/SPY' },
  { method: 'DELETE', path: '/api/ai/analytics/SPY' },
  // ── Phase 9: ML engine ────────────────────────────────────────────────────────
  { method: 'GET',  path: '/api/ai/ml/models' },
  { method: 'GET',  path: '/api/ai/ml/models?symbol=SPY' },
  { method: 'POST', path: '/api/ai/ml/datasets/create', body: { symbol: 'SPY', timeframe: '1m' }, _mlDatasetCreate: true },
  // champion/challenger with no models — should 404 gracefully
  { method: 'GET',  path: '/api/ai/ml/champion/SMOKE_NOSUCHSYMBOL', _mlChampion404: true },
  // inference with no champion — should 422 gracefully
  { method: 'POST', path: '/api/ai/ml/inference/SMOKE_NOSUCHSYMBOL', _mlInferenceNoChampion: true },
  // feature importance with invalid id — should 404 gracefully
  { method: 'GET',  path: '/api/ai/ml/feature-importance/nosuchmodel', _mlFI404: true },
  // drift with invalid model id — should 404 gracefully
  { method: 'GET',  path: '/api/ai/ml/drift/nosuchmodel', _mlDrift404: true },
  // ── Phase 11: Execution Layer ─────────────────────────────────────────────────
  { method: 'GET',  path: '/api/execution/status',       _execStatusCheck: true },
  { method: 'GET',  path: '/api/execution/risk' },
  // Kill switch toggle
  { method: 'POST', path: '/api/execution/risk/kill-switch', _execKillSwitchOn: true },
  { method: 'DELETE', path: '/api/execution/risk/kill-switch', _execKillSwitchOff: true },
  // Place paper order (expect 422 because kill switch may be on — actually off after DELETE)
  { method: 'POST', path: '/api/execution/orders', body: { symbol: 'SPY', side: 'buy', quantity: 1, type: 'market', mode: 'paper', strategyId: 'smoke-exec' }, _execOrderPlace: true },
  // Try live order — must be rejected (live gates not set)
  { method: 'POST', path: '/api/execution/orders', body: { symbol: 'SPY', side: 'buy', quantity: 1, type: 'market', mode: 'live' }, _execLiveModeBlocked: true },
  // Idempotent order with same clientOrderId
  { method: 'POST', path: '/api/execution/orders', body: { symbol: 'SPY', side: 'buy', quantity: 2, type: 'market', mode: 'paper', clientOrderId: 'smoke-dedup-001' }, _execIdempotent1: true },
  { method: 'POST', path: '/api/execution/orders', body: { symbol: 'SPY', side: 'buy', quantity: 2, type: 'market', mode: 'paper', clientOrderId: 'smoke-dedup-001' }, _execIdempotent2: true },
  // Risk check — oversized order should be rejected
  { method: 'POST', path: '/api/execution/orders', body: { symbol: 'SPY', side: 'buy', quantity: 999999, type: 'market', mode: 'paper' }, _execRiskRejected: true },
  // List orders and fills
  { method: 'GET',  path: '/api/execution/orders' },
  { method: 'GET',  path: '/api/execution/fills' },
  { method: 'GET',  path: '/api/execution/analytics', _execAnalytics: true },
  // ── Phase 12: OMS ──────────────────────────────────────────────────────────────
  { method: 'GET',  path: '/api/oms/stats',                _omsStats: true },
  { method: 'GET',  path: '/api/oms/orders',               _omsOrderList: true },
  { method: 'GET',  path: '/api/oms/orders/open',          _omsOpenList: true },
  { method: 'GET',  path: '/api/oms/events' },
  { method: 'GET',  path: '/api/oms/reconcile/runs' },
  // Create paper order
  { method: 'POST', path: '/api/oms/orders', body: { symbol: 'SPY', side: 'buy', quantity: 5, type: 'market', mode: 'paper', strategyId: 'smoke-oms' }, _omsCreate: true },
  // Idempotent create
  { method: 'POST', path: '/api/oms/orders', body: { symbol: 'SPY', side: 'sell', quantity: 3, type: 'limit', mode: 'paper', clientOrderId: 'oms-smoke-dedup-001' }, _omsIdemp1: true },
  { method: 'POST', path: '/api/oms/orders', body: { symbol: 'SPY', side: 'sell', quantity: 9, type: 'limit', mode: 'paper', clientOrderId: 'oms-smoke-dedup-001' }, _omsIdemp2: true },
  // Reconcile paper mode
  { method: 'POST', path: '/api/oms/reconcile?mode=paper', _omsRecon: true },
  // ── Phase 13: Multi-Asset Analytics ──────────────────────────────────────────
  { method: 'GET', path: '/api/multi-asset/sectors' },
  { method: 'GET', path: '/api/multi-asset/correlation?symbols=SPY,QQQ,IWM&timeframe=1d&window=20', _maCorr: true },
  { method: 'GET', path: '/api/multi-asset/beta?symbols=QQQ,IWM&benchmark=SPY&timeframe=1d&window=20', _maBeta: true },
  { method: 'GET', path: '/api/multi-asset/sector-rotation?timeframe=1d&window=20', _maSector: true },
  { method: 'GET', path: '/api/multi-asset/volatility?symbols=SPY,QQQ,IWM&timeframe=1d&window=20', _maVol: true },
  { method: 'GET', path: '/api/multi-asset/heatmap?symbols=SPY,QQQ,IWM&timeframe=1d&window=20', _maHeatmap: true },
  { method: 'GET', path: '/api/multi-asset/relative-performance?symbols=QQQ,IWM&benchmark=SPY&timeframe=1d&window=30', _maRelPerf: true },
  // ── Phase 14: Institutional Toolkit ──────────────────────────────────────────
  // Preset catalogue
  { method: 'GET', path: '/api/institutional/scenarios/presets', _instPresets: true },
  // Volatility sizing — smoke with known inputs; verify formula reproducibility
  { method: 'POST', path: '/api/institutional/sizing/volatility',
    body: { accountSize: 100000, riskPct: 0.01, annualizedVol: 0.20, currentPrice: 500, horizonDays: 1, mode: 'paper' },
    _instVolSizing: true },
  // Volatility sizing with ML confidence
  { method: 'POST', path: '/api/institutional/sizing/volatility',
    body: { accountSize: 100000, riskPct: 0.01, annualizedVol: 0.20, currentPrice: 500, horizonDays: 1, mlSignalConfidence: 0.80, mode: 'paper' },
    _instVolSizingML: true },
  // Kelly sizing — verify formula and cap behaviour
  { method: 'POST', path: '/api/institutional/sizing/kelly',
    body: { accountSize: 100000, winProbability: 0.55, avgWinPct: 0.08, avgLossPct: 0.04, currentPrice: 500, kellyFraction: 0.5, maxKellyPct: 0.25, mode: 'paper' },
    _instKelly: true },
  // Kelly with ML confidence scaling
  { method: 'POST', path: '/api/institutional/sizing/kelly',
    body: { accountSize: 100000, winProbability: 0.55, avgWinPct: 0.08, avgLossPct: 0.04, kellyFraction: 0.5, maxKellyPct: 0.25, mlSignalConfidence: 0.70, mode: 'paper' },
    _instKellyML: true },
  // Kelly with negative edge (should return rawKelly < 0, cappedKelly = 0)
  { method: 'POST', path: '/api/institutional/sizing/kelly',
    body: { accountSize: 100000, winProbability: 0.30, avgWinPct: 0.05, avgLossPct: 0.10, mode: 'paper' },
    _instKellyNeg: true },
  // Custom scenario
  { method: 'POST', path: '/api/institutional/scenarios/run',
    body: {
      name: 'Smoke Crash -20%',
      shocks: { SPY: -0.20, QQQ: -0.25, '*': -0.20 },
      positions: [
        { symbol: 'SPY', quantity: 100, currentPrice: 500, side: 'long' },
        { symbol: 'QQQ', quantity: 50,  currentPrice: 450, side: 'long' },
      ],
      accountSize: 100000,
      mode: 'paper',
    },
    _instScenario: true },
  // Preset stress pack
  { method: 'POST', path: '/api/institutional/scenarios/stress-pack/covid_2020',
    body: {
      positions: [
        { symbol: 'SPY', quantity: 100, currentPrice: 500, side: 'long' },
        { symbol: 'TLT', quantity: 50,  currentPrice: 100, side: 'long' },
      ],
      accountSize: 100000,
      mode: 'paper',
    },
    _instStressPack: true },
  // List scenarios
  { method: 'GET', path: '/api/institutional/scenarios' },
  // Audit trail
  { method: 'GET', path: '/api/institutional/audit', _instAudit: true },
  // Export report (no auditIds — empty bundle still produces valid report)
  { method: 'POST', path: '/api/institutional/report/export',
    body: { title: 'Smoke Report', mode: 'paper', analyst: 'smoke-test', accountSize: 100000 },
    _instExport: true },
  // Verify unknown packId returns 400
  { method: 'POST', path: '/api/institutional/scenarios/stress-pack/no_such_pack',
    body: { positions: [{ symbol: 'SPY', quantity: 1, currentPrice: 500, side: 'long' }] },
    _instBadPack: true },
  // ── Phase 15: Professional Platform Hardening ─────────────────────────────────
  { method: 'GET',  path: '/api/observability/health',           _obsHealth: true },
  { method: 'GET',  path: '/api/observability/metrics',          _obsMetrics: true },
  { method: 'POST', path: '/api/observability/metrics/reset',    _obsMetricsReset: true },
  { method: 'GET',  path: '/api/observability/market-session',   _obsMarketSession: true },
  { method: 'GET',  path: '/api/observability/websocket-stats',  _obsWsStats: true },
  { method: 'POST', path: '/api/observability/failover-drill',   _obsFailoverDrill: true },
  { method: 'GET',  path: '/api/observability/rate-limit-status', _obsRateLimit: true },
  // Market session guard: paper mode must always pass (never blocked)
  { method: 'POST', path: '/api/execution/orders',
    body: { symbol: 'SPY', side: 'buy', quantity: 1, type: 'market', mode: 'paper' },
    _obsSessionGuardPaper: true },
  // Market session guard: live mode must be blocked outside hours (422 or rejected by risk gate)
  { method: 'POST', path: '/api/execution/orders',
    body: { symbol: 'SPY', side: 'buy', quantity: 1, type: 'market', mode: 'live' },
    _obsSessionGuardLive: true },
];

async function waitForReady(timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/runtime/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not become ready on ${BASE_URL}`);
}

async function run() {
  const { strategyEngine } = await import('../server/strategies/strategyEngine.js');

  const provisionalCandidates = strategyEngine.generateFromSignals(
    'SMOKE',
    [{ direction: 'bullish', confidence: 0.65, strength: 0.62, reason: 'Momentum breakout alpha' }],
    [],
    '1m',
  );
  if (!Array.isArray(provisionalCandidates) || provisionalCandidates.length === 0) {
    throw new Error('Expected provisional candidate for strong alpha-only signal');
  }
  if (provisionalCandidates[0].type !== 'provisional' || provisionalCandidates[0].status !== 'needs_confirmation') {
    throw new Error('Provisional candidate missing type/status markers');
  }

  const weakCandidates = strategyEngine.generateFromSignals(
    'SMOKE',
    [{ direction: 'bullish', confidence: 0.2, strength: 0.25, reason: 'Weak alpha' }],
    [],
    '1m',
  );
  if (weakCandidates.length === 0 || weakCandidates[0].type !== 'test_candidate' || weakCandidates[0].status !== 'research_only') {
    throw new Error('Weak alpha-only context should produce a research test candidate');
  }

  const quantContextOnlyCandidates = strategyEngine.generateFromSignals(
    'SMOKE',
    [],
    [{ feature: 'alpha_count', value: 1 }],
    '1m',
  );
  if (quantContextOnlyCandidates.length === 0 || quantContextOnlyCandidates[0].type !== 'test_candidate') {
    throw new Error('Quant context without alignment should produce a research test candidate');
  }

  const emptyCandidates = strategyEngine.generateFromSignals('SMOKE', [], [], '1m');
  if (emptyCandidates.length !== 0) {
    throw new Error('Empty inputs must not produce strategy candidates');
  }

  const server = spawn(process.execPath, ['server/index.cjs'], {
    env: { ...process.env, PORT: String(PORT), MONGO_URI: process.env.MONGO_URI || '', RATE_LIMIT_MAX: '1000', RATE_LIMIT_STRICT_MAX: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  try {
    await waitForReady();
    let createdRuleSetId = '';
    let backtestRunId = '';
    for (const check of checks) {
      let path = check.path;
      if (path.includes(':id')) {
        path = path.replace(':id', createdRuleSetId);
      }
      const response = await fetch(`${BASE_URL}${path}`, {
        method: check.method,
        headers: { 'Content-Type': 'application/json' },
        body: check.body ? JSON.stringify(check.body) : undefined,
      });

      const text = await response.text();
      let parsed;

      // HTML export returns text/html — skip JSON parse + skip JSON-only checks
      if (check._exportCheck) {
        if (!response.ok) throw new Error(`${path} HTML export failed with ${response.status}`);
        if (!text.includes('<!DOCTYPE html') && !text.includes('<html')) throw new Error(`${path} HTML export missing DOCTYPE`);
        if (!text.includes('noLookaheadVerified') && !text.includes('Backtest Report')) throw new Error(`${path} HTML export missing report content`);
        console.log(`OK ${check.method} ${path}`);
        continue;
      }

      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${check.method} ${check.path} did not return JSON`);
      }

      if (!response.ok && !check._previewNoDisclaimer && !check._portfolioLiveCheck
          && !check._mlChampion404 && !check._mlInferenceNoChampion && !check._mlFI404 && !check._mlDrift404
          && !check._execLiveModeBlocked && !check._execRiskRejected && !check._execCancelFilled
          && !check._omsNotFound && !check._instBadPack && !check._obsSessionGuardLive && !check._obsSessionGuardPaper) {
        throw new Error(`${check.method} ${path} failed with ${response.status}: ${JSON.stringify(parsed)}`);
      }

      if (check.path === '/api/quant/pipeline/SPY' && !Array.isArray(parsed.qualityScores)) {
        throw new Error('POST /api/quant/pipeline/SPY missing qualityScores array');
      }

      // ── Phase 8D: backtest engine hardening checks ─────────────────────────
      if (check.method === 'POST' && check.path === '/api/backtest/run/SPY') {
        backtestRunId = parsed?.result?.id || '';
        if (!parsed.ok) throw new Error('POST /api/backtest/run/SPY returned ok:false');
        const r = parsed.result;
        if (!r) throw new Error('POST /api/backtest/run/SPY missing result');
        if (typeof r.noLookaheadVerified !== 'boolean') throw new Error('backtest result missing noLookaheadVerified');
        if (r.noLookaheadVerified !== true) throw new Error('noLookaheadVerified must be true for standard run');
        if (!r.config || typeof r.config.stopLossPercent !== 'number') throw new Error('backtest result missing config.stopLossPercent');
        if (backtestRunId) {
          checks.push({ method: 'GET',  path: `/api/backtest/runs/SPY/${backtestRunId}`, _btRunCheck: true });
          checks.push({ method: 'POST', path: `/api/backtest/monte-carlo/SPY/${backtestRunId}`, body: { iterations: 200 }, _mcCheck: true });
          checks.push({ method: 'GET',  path: `/api/backtest/monte-carlo/SPY/${backtestRunId}`, _mcListCheck: true });
          checks.push({ method: 'GET',  path: `/api/backtest/export/SPY/${backtestRunId}`, _exportCheck: true });
        }
      }

      if (check.method === 'GET' && check.path === '/api/backtest/runs/SPY') {
        if (!parsed.ok || !Array.isArray(parsed.runs)) throw new Error('/api/backtest/runs/SPY missing runs array');
      }

      if (check.method === 'POST' && check.path === '/api/backtest/walk-forward/SPY') {
        if (!parsed.ok) throw new Error('POST /api/backtest/walk-forward/SPY returned ok:false');
        const r = parsed.result;
        if (!r || !Array.isArray(r.windows)) throw new Error('walk-forward result missing windows array');
        if (!r.aggregateMetrics || typeof r.aggregateMetrics.numberOfTrades !== 'number') throw new Error('walk-forward missing aggregateMetrics.numberOfTrades');
      }

      if (check.method === 'GET' && check.path === '/api/backtest/walk-forward/SPY') {
        if (!parsed.ok || !Array.isArray(parsed.runs)) throw new Error('GET /api/backtest/walk-forward/SPY missing runs array');
      }

      if (check._btRunCheck) {
        if (!parsed.ok || !parsed.run) throw new Error(`${check.path} missing run`);
        if (typeof parsed.run.noLookaheadVerified !== 'boolean') throw new Error(`${check.path} run missing noLookaheadVerified`);
      }

      if (check._mcCheck) {
        if (!parsed.ok || !parsed.result) throw new Error(`${check.path} monte-carlo missing result`);
        const mc = parsed.result;
        if (!mc.summary || mc.summary.iterations == null) throw new Error('monte-carlo missing summary.iterations');
        if (!mc.summary.totalPnL || mc.summary.totalPnL.median == null) throw new Error('monte-carlo summary missing totalPnL.median');
      }

      if (check._mcListCheck) {
        if (!parsed.ok || !Array.isArray(parsed.runs)) throw new Error(`${check.path} missing runs array`);
      }

      if (check._exportCheck) {
        // HTML export returns text/html — skip JSON parse error for this check
        if (!response.ok) throw new Error(`${check.path} export failed with ${response.status}`);
      }



      if (check.method === 'POST' && check.path === '/api/templates/strategies/opening-gap-contrarian-reversal/create-rule-set') {
        const templateRuleSetId = parsed?.ruleSet?.id || '';
        if (!templateRuleSetId) throw new Error('Template create-rule-set response missing id');
        const evalResponse = await fetch(`${BASE_URL}/api/rules/evaluate/SPY/${templateRuleSetId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const evalParsed = await evalResponse.json();
        if (!evalResponse.ok) {
          throw new Error(`Template rule set evaluate failed with ${evalResponse.status}: ${JSON.stringify(evalParsed)}`);
        }
        const sessionContextEvals = [
          ...(Array.isArray(evalParsed.matchedConditions) ? evalParsed.matchedConditions : []),
          ...(Array.isArray(evalParsed.failedConditions) ? evalParsed.failedConditions : []),
        ].filter((condition) => condition?.source === 'sessionContext');
        if (sessionContextEvals.length === 0) {
          throw new Error('Template rule set evaluation missing sessionContext condition results');
        }
        console.log(`OK POST /api/rules/evaluate/SPY/${templateRuleSetId} (template sessionContext check)`);
      }

      if (check.method === 'POST' && check.path === '/api/rules/set/SPY') {
        createdRuleSetId = parsed?.ruleSet?.id || '';
        if (!createdRuleSetId) throw new Error('POST /api/rules/set/SPY missing created rule set id');
        checks.push({ method: 'POST', path: `/api/rules/evaluate/SPY/${createdRuleSetId}` });
        checks.push({ method: 'POST', path: `/api/rules/convert/SPY/${createdRuleSetId}` });
        // Phase 8C: validate + preview routes
        checks.push({ method: 'POST', path: `/api/rules/validate/${createdRuleSetId}`, body: {}, _validateCheck: true });
        checks.push({ method: 'POST', path: `/api/rules/preview/SPY/${createdRuleSetId}`, body: {}, _previewNoDisclaimer: true });
        checks.push({ method: 'POST', path: `/api/rules/preview/SPY/${createdRuleSetId}`, body: { disclaimerAccepted: true }, _previewWithDisclaimer: true });
      }

      // Alert engine: validate structure + inject CRUD checks for first price_above alert
      // ── CVD checks ──────────────────────────────────────────────────────────
      if (check._cvdCheck) {
        if (!parsed.success) throw new Error(`${check.path} returned success:false`);
        if (!Array.isArray(parsed.bars)) throw new Error(`${check.path} missing bars array`);
        if (typeof parsed.fallback !== 'boolean') throw new Error(`${check.path} missing fallback boolean`);
        if (!parsed.source) throw new Error(`${check.path} missing source`);
        if (!parsed.sourceClassification) throw new Error(`${check.path} missing sourceClassification`);
        if (typeof parsed.sessionResets !== 'number') throw new Error(`${check.path} missing sessionResets`);
        if (!parsed.liveState || typeof parsed.liveState.cumDelta !== 'number') throw new Error(`${check.path} missing liveState.cumDelta`);
        if (parsed.bars.length > 0) {
          const bar = parsed.bars[0];
          if (bar.delta == null || bar.cumDelta == null || bar.source == null || typeof bar.fallback !== 'boolean') {
            throw new Error(`${check.path} bar missing required fields (delta/cumDelta/source/fallback)`);
          }
        }
        // When using OHLCV synthetic fallback, fallback must be true
        if (parsed.source === 'ohlcv_synthetic' && !parsed.fallback) {
          throw new Error(`${check.path} ohlcv_synthetic source must set fallback:true`);
        }
      }

      // ── Footprint checks ─────────────────────────────────────────────────────
      if (check._fpCheck) {
        if (!parsed.success) throw new Error(`${check.path} returned success:false`);
        if (!Array.isArray(parsed.bars)) throw new Error(`${check.path} missing bars array`);
        if (typeof parsed.fallback !== 'boolean') throw new Error(`${check.path} missing fallback boolean`);
        if (typeof parsed.imbalancesDisabled !== 'boolean') throw new Error(`${check.path} missing imbalancesDisabled boolean`);
        if (typeof parsed.clusterSize !== 'number' || parsed.clusterSize <= 0) throw new Error(`${check.path} missing valid clusterSize`);
        if (typeof parsed.imbalanceThreshold !== 'number') throw new Error(`${check.path} missing imbalanceThreshold`);
        // Synthetic source must disable imbalances
        if (parsed.source === 'ohlcv_synthetic' && !parsed.imbalancesDisabled) {
          throw new Error(`${check.path} synthetic source must set imbalancesDisabled:true`);
        }
        // Synthetic source must set fallback:true
        if (parsed.source === 'ohlcv_synthetic' && !parsed.fallback) {
          throw new Error(`${check.path} synthetic source must set fallback:true`);
        }
        // Validate bar structure
        if (parsed.bars.length > 0) {
          const bar = parsed.bars[0];
          if (!Array.isArray(bar.levels)) throw new Error(`${check.path} bar missing levels array`);
          if (typeof bar.delta !== 'number') throw new Error(`${check.path} bar missing delta`);
          if (typeof bar.maxLevelVol !== 'number') throw new Error(`${check.path} bar missing maxLevelVol`);
          if (bar.poc == null) throw new Error(`${check.path} bar missing poc`);
          // Validate level structure
          if (bar.levels.length > 0) {
            const lvl = bar.levels[0];
            if (typeof lvl.price !== 'number') throw new Error(`${check.path} level missing price`);
            if (typeof lvl.bidVol !== 'number') throw new Error(`${check.path} level missing bidVol`);
            if (typeof lvl.askVol !== 'number') throw new Error(`${check.path} level missing askVol`);
            if (typeof lvl.totalVol !== 'number') throw new Error(`${check.path} level missing totalVol`);
            // Imbalance fields must be null when imbalancesDisabled
            if (parsed.imbalancesDisabled && lvl.imbalance !== null) {
              throw new Error(`${check.path} level imbalance must be null when imbalancesDisabled`);
            }
          }
        }
        // Warnings must mention synthetic mode when fallback active
        if (parsed.fallback && parsed.imbalancesDisabled) {
          const hasImbalanceWarning = Array.isArray(parsed.warnings) &&
            parsed.warnings.some((w) => String(w).toLowerCase().includes('imbalance'));
          if (!hasImbalanceWarning) throw new Error(`${check.path} missing imbalance disabled warning`);
        }
      }

      if (check.method === 'GET' && check.path === '/api/alerts') {
        if (!parsed.success || !Array.isArray(parsed.alerts)) throw new Error('/api/alerts missing alerts array');
      }

      if (check.method === 'GET' && check.path === '/api/alerts/diagnostics') {
        if (!parsed.success || parsed.evalIntervalMs == null) throw new Error('/api/alerts/diagnostics missing evalIntervalMs');
        if (typeof parsed.activeAlerts !== 'number')          throw new Error('/api/alerts/diagnostics missing activeAlerts');
      }

      if (check.method === 'GET' && check.path === '/api/alerts/history') {
        if (!parsed.success || !Array.isArray(parsed.history)) throw new Error('/api/alerts/history missing history array');
      }

      if (check.method === 'POST' && check.path === '/api/alerts' && parsed?.alert?.type === 'price_above') {
        const alertId = parsed?.alert?.id || '';
        if (!alertId) throw new Error('POST /api/alerts missing alert id');
        if (parsed.alert.symbol !== 'SPY') throw new Error('alert symbol mismatch');
        // Inject further CRUD checks for this alert
        checks.push({ method: 'GET',    path: `/api/alerts/${alertId}`,         _alertId: alertId });
        checks.push({ method: 'PUT',    path: `/api/alerts/${alertId}`,         body: { threshold: 9999 }, _alertId: alertId });
        checks.push({ method: 'POST',   path: `/api/alerts/${alertId}/disable`, _alertId: alertId });
        checks.push({ method: 'POST',   path: `/api/alerts/${alertId}/enable`,  _alertId: alertId });
        checks.push({ method: 'DELETE', path: `/api/alerts/${alertId}`,         _alertId: alertId });
      }

      if (check._alertId) {
        if (!parsed.success) throw new Error(`${check.method} ${check.path} returned success:false`);
        if (check.method === 'GET' && !check.path.endsWith('/disable') && !check.path.endsWith('/enable')) {
          if (!parsed.alert?.id) throw new Error(`${check.path} missing alert.id`);
        }
        if (check.method === 'PUT' && parsed.alert?.threshold !== 9999) {
          throw new Error('PUT /api/alerts/:id threshold not updated');
        }
      }

      if (check.method === 'GET' && check.path === '/api/alerts?symbol=SPY') {
        if (!parsed.success || !Array.isArray(parsed.alerts)) throw new Error('/api/alerts?symbol=SPY missing alerts array');
        const types = parsed.alerts.map((a) => a.type);
        const required = ['price_above', 'rsi_below', 'ema_bullish_cross', 'vwap_cross_up', 'poc_touch', 'vah_break', 'val_break', 'volume_spike'];
        for (const t of required) {
          if (!types.includes(t)) throw new Error(`/api/alerts?symbol=SPY missing alert type: ${t}`);
        }
      }

      if (check.method === 'POST' && check.path === '/api/feeds/providers/polygon/credentials') {
        const maskedFields = parsed?.credentials?.maskedFields || [];
        if (!parsed?.credentials?.configured || !Array.isArray(maskedFields) || maskedFields.some((field) => String(field).includes('fake_polygon_key_12345'))) {
          throw new Error('Polygon credentials must be masked and never returned raw');
        }
      }

      if (check.method === 'GET' && check.path === '/api/feeds/providers/polygon') {
        const provider = parsed?.provider || {};
        if (!provider.configured || !Array.isArray(provider.maskedFields) || provider.maskedFields.some((field) => String(field).includes('fake_polygon_key_12345'))) {
          throw new Error('GET provider should only return masked credential metadata');
        }
      }

      if (check._validateCheck) {
        if (!parsed.ok) throw new Error(`POST ${check.path} returned ok:false`);
        if (typeof parsed.valid !== 'boolean') throw new Error(`validate response missing valid boolean`);
        if (!parsed.errors || !parsed.warnings) throw new Error(`validate response missing errors/warnings maps`);
        if (!parsed.disclaimer) throw new Error(`validate response missing disclaimer`);
      }

      if (check._previewNoDisclaimer) {
        if (response.status !== 403) throw new Error(`preview without disclaimer must return 403, got ${response.status}`);
        if (!parsed.disclaimer) throw new Error(`403 preview response missing disclaimer`);
      }

      if (check._previewWithDisclaimer) {
        if (!parsed.ok) throw new Error(`POST ${check.path} (with disclaimer) returned ok:false`);
        if (!parsed.preview) throw new Error(`preview response missing preview:true`);
        if (!parsed.result) throw new Error(`preview response missing result`);
        if (!parsed.disclaimer) throw new Error(`preview response missing disclaimer`);
      }

      // ── Portfolio checks ─────────────────────────────────────────────────────
      if (check._portfolioCheck) {
        if (!parsed.success) throw new Error(`${check.path} returned success:false`);
        if (parsed.mode !== 'paper') throw new Error(`${check.path} missing mode:paper`);
        if (parsed.modeBadge !== 'PAPER') throw new Error(`${check.path} missing modeBadge:PAPER`);
      }

      if (check._portfolioVarCheck) {
        if (!parsed.success) throw new Error(`${check.path} returned success:false`);
        if (parsed.mode !== 'paper') throw new Error(`${check.path} missing mode:paper`);
        if (typeof parsed.var !== 'number') throw new Error(`${check.path} missing var number`);
        if (typeof parsed.confidence !== 'number') throw new Error(`${check.path} missing confidence`);
        if (typeof parsed.horizon !== 'number') throw new Error(`${check.path} missing horizon`);
        if (parsed.method !== 'parametric_normal') throw new Error(`${check.path} missing method:parametric_normal`);
      }

      if (check._portfolioStressCheck) {
        if (!parsed.success) throw new Error(`${check.path} returned success:false`);
        if (parsed.mode !== 'paper') throw new Error(`${check.path} missing mode:paper`);
        if (!Array.isArray(parsed.scenarios)) throw new Error(`${check.path} missing scenarios array`);
        if (parsed.scenarios.length !== 2) throw new Error(`${check.path} expected 2 scenario results`);
        for (const s of parsed.scenarios) {
          if (!s.name) throw new Error(`${check.path} scenario missing name`);
          if (typeof s.pnlImpact !== 'number') throw new Error(`${check.path} scenario missing pnlImpact`);
          if (!Array.isArray(s.details)) throw new Error(`${check.path} scenario missing details array`);
        }
      }

      if (check._portfolioLiveCheck) {
        if (response.status !== 503) throw new Error(`${check.path} live mode must return 503, got ${response.status}`);
        if (!parsed.error) throw new Error(`${check.path} live mode 503 missing error message`);
      }

      // ── Phase 9: ML engine checks ────────────────────────────────────────────
      if (check._mlDatasetCreate) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.datasetId) throw new Error(`${check.path} missing datasetId`);
        if (!parsed.metadata) throw new Error(`${check.path} missing metadata`);
        if (typeof parsed.metadata.sampleCount !== 'number') throw new Error(`${check.path} missing metadata.sampleCount`);
        // Inject training start for the smoke check symbol (non-blocking — status check follows)
        checks.push({
          method: 'POST', path: '/api/ai/ml/training/start',
          body: { symbol: 'SPY', timeframe: '1m', modelType: 'XGBoost', horizon: 5, notes: 'smoke test training' },
          _mlTrainingStart: true,
        });
      }

      if (check._mlTrainingStart) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.jobId) throw new Error(`${check.path} missing jobId`);
        if (!['running', 'completed', 'failed'].includes(parsed.status)) throw new Error(`${check.path} invalid status: ${parsed.status}`);
        // Inject training status check
        checks.push({ method: 'GET', path: `/api/ai/ml/training/status/${parsed.jobId}`, _mlTrainingStatus: true });
      }

      if (check._mlTrainingStatus) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.job) throw new Error(`${check.path} missing job`);
        if (typeof parsed.job.status !== 'string') throw new Error(`${check.path} job missing status`);
        // If completed, inject champion/model checks
        if (parsed.job.status === 'completed' && parsed.job.result?.model?.modelId) {
          const mid = parsed.job.result.model.modelId;
          checks.push({ method: 'GET', path: `/api/ai/ml/models/${mid}`, _mlModelGet: true });
          checks.push({ method: 'GET', path: `/api/ai/ml/feature-importance/${mid}`, _mlFICheck: true });
          checks.push({ method: 'GET', path: `/api/ai/ml/champion/SPY`, _mlChampionCheck: true });
          checks.push({ method: 'POST', path: `/api/ai/ml/models/${mid}/promote`, _mlPromoteCheck: true });
          checks.push({ method: 'POST', path: `/api/ai/ml/inference/SPY`, body: { timeframe: '1m' }, _mlInferenceCheck: true });
        }
      }

      if (check._mlModelGet) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.model?.modelId) throw new Error(`${check.path} missing model.modelId`);
        if (!parsed.model?.featureSet?.length) throw new Error(`${check.path} model missing featureSet`);
        if (!parsed.model?.datasetHash) throw new Error(`${check.path} model missing datasetHash`);
        if (typeof parsed.model?.horizon !== 'number') throw new Error(`${check.path} model missing horizon`);
        if (!parsed.model?.trainingTimestamp) throw new Error(`${check.path} model missing trainingTimestamp`);
      }

      if (check._mlFICheck) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.ranked)) throw new Error(`${check.path} missing ranked array`);
        if (typeof parsed.featureImportance !== 'object') throw new Error(`${check.path} missing featureImportance object`);
      }

      if (check._mlChampionCheck) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.champion?.modelId) throw new Error(`${check.path} missing champion.modelId`);
        if (parsed.champion.status !== 'champion') throw new Error(`${check.path} champion status must be champion`);
      }

      if (check._mlPromoteCheck) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.model?.modelId) throw new Error(`${check.path} missing model.modelId`);
      }

      if (check._mlInferenceCheck) {
        if (!parsed.ok) {
          // Inference may fail if not enough feature records — acceptable in smoke
          if (!parsed.warnings?.length) throw new Error(`${check.path} failed ok:false with no warnings`);
        } else {
          if (!parsed.modelId) throw new Error(`${check.path} missing modelId`);
          if (!parsed.prediction) throw new Error(`${check.path} missing prediction`);
          if (typeof parsed.confidence !== 'number') throw new Error(`${check.path} missing confidence`);
        }
      }

      if (check._mlChampion404) {
        if (response.status !== 404) throw new Error(`${check.path} no-symbol champion must return 404, got ${response.status}`);
      }

      if (check._mlInferenceNoChampion) {
        if (![404, 422].includes(response.status)) throw new Error(`${check.path} no-champion inference must return 404 or 422, got ${response.status}`);
      }

      if (check._mlFI404) {
        if (response.status !== 404) throw new Error(`${check.path} missing model must return 404, got ${response.status}`);
      }

      if (check._mlDrift404) {
        if (response.status !== 404) throw new Error(`${check.path} missing model must return 404, got ${response.status}`);
      }

      // ── Phase 11: Execution Layer checks ────────────────────────────────────
      if (check._execStatusCheck) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.mode) throw new Error(`${check.path} missing mode field`);
        if (!parsed.modeBadge) throw new Error(`${check.path} missing modeBadge field`);
        if (parsed.liveExecutionEnabled == null) throw new Error(`${check.path} missing liveExecutionEnabled flag`);
        if (parsed.phase12OMSReady == null) throw new Error(`${check.path} missing phase12OMSReady flag`);
        // Default: live must be off
        if (parsed.liveExecutionEnabled !== false) throw new Error(`${check.path} liveExecutionEnabled must be false by default`);
      }

      if (check._execKillSwitchOn) {
        if (!parsed.ok) throw new Error(`${check.path} kill switch enable returned ok:false`);
        if (!parsed.killSwitch) throw new Error(`${check.path} killSwitch must be true after enable`);
      }

      if (check._execKillSwitchOff) {
        if (!parsed.ok) throw new Error(`${check.path} kill switch disable returned ok:false`);
        if (parsed.killSwitch) throw new Error(`${check.path} killSwitch must be false after disable`);
      }

      if (check._execOrderPlace) {
        // Paper order must succeed (kill switch was re-disabled before this)
        if (!parsed.ok) throw new Error(`${check.path} paper order placement returned ok:false: ${JSON.stringify(parsed)}`);
        if (!parsed.order?.orderId) throw new Error(`${check.path} missing order.orderId`);
        if (!parsed.order?.clientOrderId) throw new Error(`${check.path} missing order.clientOrderId`);
        if (parsed.mode !== 'paper') throw new Error(`${check.path} mode must be paper`);
        if (parsed.modeBadge !== 'PAPER') throw new Error(`${check.path} modeBadge must be PAPER`);
        if (parsed.order.status !== 'filled') throw new Error(`${check.path} paper order must fill immediately, got ${parsed.order.status}`);
        // Inject cancel check for a second order
        checks.push({
          method: 'POST', path: '/api/execution/orders',
          body: { symbol: 'SPY', side: 'sell', quantity: 1, type: 'market', mode: 'paper', clientOrderId: `smoke-cancel-${Date.now()}` },
          _execForCancel: true,
        });
      }

      if (check._execForCancel) {
        if (!parsed.ok) throw new Error(`${check.path} cancel-prep order failed: ${JSON.stringify(parsed)}`);
        // Try canceling a filled order — should fail gracefully
        if (parsed.order?.orderId) {
          checks.push({ method: 'DELETE', path: `/api/execution/orders/${parsed.order.orderId}`, _execCancelFilled: true });
          checks.push({ method: 'GET',    path: `/api/execution/orders/${parsed.order.orderId}` });
        }
      }

      if (check._execCancelFilled) {
        // Canceling a filled order must return 422 (not 500)
        if (response.status !== 422) throw new Error(`${check.path} canceling filled order must return 422, got ${response.status}`);
      }

      if (check._execLiveModeBlocked) {
        // Live orders must be rejected when env flags not set
        if (response.status !== 422) throw new Error(`${check.path} live order without flags must return 422, got ${response.status}`);
        if (!parsed.order) throw new Error(`${check.path} live-blocked response missing order`);
        if (parsed.order.status !== 'rejected') throw new Error(`${check.path} live-blocked order must have status rejected`);
        if (!['MODE_GATE', 'PHASE12_GATE'].includes(parsed.riskCode)) throw new Error(`${check.path} wrong riskCode for live gate: ${parsed.riskCode}`);
      }

      if (check._execIdempotent1) {
        if (!parsed.ok) throw new Error(`${check.path} first idempotent order failed`);
        if (!parsed.order?.clientOrderId) throw new Error(`${check.path} missing clientOrderId`);
      }

      if (check._execIdempotent2) {
        if (!parsed.ok) throw new Error(`${check.path} second idempotent order failed`);
        if (!parsed.idempotent) throw new Error(`${check.path} repeated clientOrderId must set idempotent:true`);
        if (parsed.order?.quantity !== 2) throw new Error(`${check.path} idempotent response must return original quantity`);
      }

      if (check._execRiskRejected) {
        if (response.status !== 422) throw new Error(`${check.path} oversized order must return 422, got ${response.status}`);
        if (!parsed.order) throw new Error(`${check.path} risk-rejected response missing order`);
        if (parsed.order.status !== 'rejected') throw new Error(`${check.path} risk rejected order must have status rejected`);
        if (!parsed.riskCode) throw new Error(`${check.path} risk-rejected response missing riskCode`);
      }

      if (check._execAnalytics) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.fillRate !== 'number') throw new Error(`${check.path} missing fillRate`);
        if (typeof parsed.avgSlippageBps !== 'number') throw new Error(`${check.path} missing avgSlippageBps`);
        if (!Array.isArray(parsed.symbolBreakdown)) throw new Error(`${check.path} missing symbolBreakdown array`);
      }

      if (check.method === 'GET' && check.path.startsWith('/api/volume-profile/')) {
        if (!parsed.success) throw new Error(`${check.path} returned success:false`);
        if (!Array.isArray(parsed.profile)) throw new Error(`${check.path} missing profile array`);
        const binsParam = Number(new URL(`http://x${check.path}`).searchParams.get('bins') || 50);
        if (parsed.bins !== binsParam) throw new Error(`${check.path} bins mismatch: got ${parsed.bins}`);
        if (parsed.profile.length > 0 && parsed.poc == null) throw new Error(`${check.path} missing poc`);
        if (parsed.profile.length > 0 && parsed.vah == null) throw new Error(`${check.path} missing vah`);
        if (parsed.profile.length > 0 && parsed.val == null) throw new Error(`${check.path} missing val`);
        if (!Array.isArray(parsed.hvn)) throw new Error(`${check.path} hvn must be array`);
        if (!Array.isArray(parsed.lvn)) throw new Error(`${check.path} lvn must be array`);
        if (parsed.profile.length > 0) {
          const first = parsed.profile[0];
          if (first.price == null || first.priceLevel == null || first.binLow == null || first.binHigh == null || first.volume == null) {
            throw new Error(`${check.path} profile item missing required fields (price/priceLevel/binLow/binHigh/volume)`);
          }
        }
      }

      if (check.method === 'GET' && check.path === '/api/strategy-lab/strategies/SPY') {
        const names = Array.isArray(parsed.strategies) ? parsed.strategies.map((item) => item?.name) : [];
        if (!names.includes('Smoke Manual Save') || !names.includes('Smoke Alias Save')) {
          throw new Error('GET /api/strategy-lab/strategies/SPY missing saved smoke strategies');
        }
      }

      // ── Phase 12: OMS checks ─────────────────────────────────────────────────
      if (check._omsStats) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.total !== 'number') throw new Error(`${check.path} missing total`);
        if (typeof parsed.byStatus !== 'object') throw new Error(`${check.path} missing byStatus`);
        if (typeof parsed.fillRate !== 'number') throw new Error(`${check.path} missing fillRate`);
      }

      if (check._omsOrderList) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.orders)) throw new Error(`${check.path} missing orders array`);
        if (typeof parsed.count !== 'number') throw new Error(`${check.path} missing count`);
      }

      if (check._omsOpenList) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.orders)) throw new Error(`${check.path} missing orders array`);
        if (typeof parsed.count !== 'number') throw new Error(`${check.path} missing count`);
      }

      if (check._omsCreate) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false: ${JSON.stringify(parsed)}`);
        if (!parsed.order?.orderId) throw new Error(`${check.path} missing order.orderId`);
        if (!parsed.order?.clientOrderId) throw new Error(`${check.path} missing order.clientOrderId`);
        if (parsed.order.status !== 'pending') throw new Error(`${check.path} new OMS order must have status pending, got ${parsed.order.status}`);
        if (parsed.order.symbol !== 'SPY') throw new Error(`${check.path} order symbol mismatch`);
        // Inject lifecycle smoke: submit → fill → get-with-events
        const oid = parsed.order.orderId;
        checks.push({ method: 'POST', path: `/api/oms/orders/${oid}/submit`, body: {}, _omsSubmit: true, _omsOrderId: oid });
        checks.push({ method: 'POST', path: `/api/oms/orders/${oid}/fill`, body: { fillQuantity: 5, fillPrice: 501.50, commissions: 0.5 }, _omsFill: true, _omsOrderId: oid });
        checks.push({ method: 'GET',  path: `/api/oms/orders/${oid}/events`, _omsEvents: true });
        checks.push({ method: 'GET',  path: `/api/oms/orders/${oid}`, _omsSingleGet: true });
        // Inject a pending order for cancel smoke
        checks.push({ method: 'POST', path: '/api/oms/orders', body: { symbol: 'QQQ', side: 'buy', quantity: 2, type: 'limit', requestedPrice: 450, mode: 'paper' }, _omsForCancel: true });
      }

      if (check._omsSubmit) {
        if (!parsed.ok) throw new Error(`${check.path} submit returned ok:false: ${JSON.stringify(parsed)}`);
        if (parsed.order?.status !== 'submitted') throw new Error(`${check.path} after submit status must be submitted, got ${parsed.order?.status}`);
      }

      if (check._omsFill) {
        if (!parsed.ok) throw new Error(`${check.path} fill returned ok:false: ${JSON.stringify(parsed)}`);
        if (!['filled', 'partially_filled'].includes(parsed.order?.status)) {
          throw new Error(`${check.path} after fill status must be filled or partially_filled, got ${parsed.order?.status}`);
        }
        if (typeof parsed.order.avgFillPrice !== 'number') throw new Error(`${check.path} missing avgFillPrice after fill`);
      }

      if (check._omsEvents) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.events)) throw new Error(`${check.path} missing events array`);
        if (parsed.events.length === 0) throw new Error(`${check.path} events must be non-empty after lifecycle`);
        const types = parsed.events.map((e) => e.eventType);
        if (!types.includes('order_created')) throw new Error(`${check.path} missing order_created event`);
      }

      if (check._omsSingleGet) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.order?.orderId) throw new Error(`${check.path} missing order.orderId`);
      }

      if (check._omsForCancel) {
        if (!parsed.ok) throw new Error(`${check.path} for-cancel order failed: ${JSON.stringify(parsed)}`);
        if (parsed.order?.orderId) {
          // Submit it so it's in open state, then cancel
          checks.push({ method: 'POST',   path: `/api/oms/orders/${parsed.order.orderId}/submit`, body: {} });
          checks.push({ method: 'DELETE', path: `/api/oms/orders/${parsed.order.orderId}`,        _omsCancel: true });
          // Inject children check
          checks.push({ method: 'GET',    path: `/api/oms/orders/${parsed.order.orderId}/children` });
        }
      }

      if (check._omsCancel) {
        if (!parsed.ok) throw new Error(`${check.path} cancel returned ok:false: ${JSON.stringify(parsed)}`);
        if (parsed.order?.status !== 'canceled') throw new Error(`${check.path} canceled order must have status canceled, got ${parsed.order?.status}`);
      }

      if (check._omsIdemp1) {
        if (!parsed.ok) throw new Error(`${check.path} first idempotent create failed: ${JSON.stringify(parsed)}`);
        if (!parsed.order?.orderId) throw new Error(`${check.path} missing orderId`);
      }

      if (check._omsIdemp2) {
        if (!parsed.ok) throw new Error(`${check.path} second idempotent create failed: ${JSON.stringify(parsed)}`);
        if (!parsed.idempotent) throw new Error(`${check.path} repeated clientOrderId must set idempotent:true`);
        if (parsed.order?.quantity !== 3) throw new Error(`${check.path} idempotent must return original quantity (3), got ${parsed.order?.quantity}`);
      }

      if (check._omsRecon) {
        if (!parsed.ok) throw new Error(`${check.path} reconcile returned ok:false: ${JSON.stringify(parsed)}`);
        if (typeof parsed.ordersChecked !== 'number') throw new Error(`${check.path} missing ordersChecked`);
        if (typeof parsed.divergences !== 'number') throw new Error(`${check.path} missing divergences`);
        if (typeof parsed.corrections !== 'number') throw new Error(`${check.path} missing corrections`);
        if (!parsed.runId) throw new Error(`${check.path} missing runId`);
      }

      // ── Phase 14: Institutional Toolkit checks ───────────────────────────────
      if (check._instPresets) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.presets)) throw new Error(`${check.path} missing presets array`);
        if (parsed.presets.length === 0) throw new Error(`${check.path} presets array is empty`);
        for (const p of parsed.presets) {
          if (!p.packId)      throw new Error(`preset missing packId`);
          if (!p.name)        throw new Error(`preset ${p.packId} missing name`);
          if (!p.shocks)      throw new Error(`preset ${p.packId} missing shocks`);
        }
      }

      if (check._instVolSizing) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false: ${JSON.stringify(parsed)}`);
        if (!parsed.auditId)               throw new Error(`${check.path} missing auditId`);
        if (typeof parsed.shares !== 'number' || parsed.shares <= 0) throw new Error(`${check.path} shares must be positive number`);
        if (typeof parsed.positionValue !== 'number') throw new Error(`${check.path} missing positionValue`);
        if (typeof parsed.dollarRisk !== 'number')    throw new Error(`${check.path} missing dollarRisk`);
        if (parsed.mode !== 'paper')                  throw new Error(`${check.path} mode must be paper`);
        if (parsed.mlScalingApplied !== false)        throw new Error(`${check.path} mlScalingApplied must be false when no ML`);
        // Verify formula: shares = (100000 * 0.01) / (500 * (0.20/sqrt(252)) * sqrt(1))
        const expected = (100000 * 0.01) / (500 * (0.20 / Math.sqrt(252)) * Math.sqrt(1));
        const diff = Math.abs(parsed.shares - expected);
        if (diff > 0.01) throw new Error(`${check.path} volatility sizing formula mismatch: got ${parsed.shares} expected ~${expected.toFixed(4)}`);
        // Inject audit fetch check
        checks.push({ method: 'GET', path: `/api/institutional/audit/${parsed.auditId}`, _instAuditGet: true });
      }

      if (check._instVolSizingML) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (parsed.mlScalingApplied !== true)  throw new Error(`${check.path} mlScalingApplied must be true when ML provided`);
        if (parsed.mlSignalConfidence !== 0.80) throw new Error(`${check.path} mlSignalConfidence must be 0.80`);
        if (typeof parsed.sharesUnscaled !== 'number') throw new Error(`${check.path} missing sharesUnscaled`);
        // scaled shares must be 80% of unscaled
        const ratio = parsed.shares / parsed.sharesUnscaled;
        if (Math.abs(ratio - 0.80) > 0.001) throw new Error(`${check.path} ML scaling ratio wrong: ${ratio} (expected 0.80)`);
      }

      if (check._instKelly) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false: ${JSON.stringify(parsed)}`);
        if (!parsed.auditId)                        throw new Error(`${check.path} missing auditId`);
        if (typeof parsed.rawKelly !== 'number')    throw new Error(`${check.path} missing rawKelly`);
        if (typeof parsed.cappedKelly !== 'number') throw new Error(`${check.path} missing cappedKelly`);
        if (parsed.cappedKelly > 0.25 + 1e-6)       throw new Error(`${check.path} cappedKelly exceeds maxKellyPct 0.25`);
        if (!parsed.edgePositive)                   throw new Error(`${check.path} edge must be positive for 55% win rate`);
        if (parsed.mode !== 'paper')                throw new Error(`${check.path} mode must be paper`);
        // Verify Kelly formula: b=2, p=0.55, q=0.45 → rawKelly = 0.55 - 0.45/2 = 0.325
        const expected = 0.55 - 0.45 / 2;
        if (Math.abs(parsed.rawKelly - expected) > 0.001) {
          throw new Error(`${check.path} Kelly formula mismatch: got ${parsed.rawKelly} expected ${expected}`);
        }
        // fractionalKelly = 0.325 * 0.5 = 0.1625; cappedKelly = min(0.1625, 0.25) = 0.1625
        const expectedFrac = expected * 0.5;
        if (Math.abs(parsed.fractionalKelly - expectedFrac) > 0.001) {
          throw new Error(`${check.path} fractionalKelly mismatch: got ${parsed.fractionalKelly} expected ${expectedFrac}`);
        }
      }

      if (check._instKellyML) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (parsed.mlScalingApplied !== true) throw new Error(`${check.path} mlScalingApplied must be true`);
        // adjustedKelly = fractionalKelly * 0.70
        const adjExpected = (0.55 - 0.45 / 2) * 0.5 * 0.70;
        if (Math.abs(parsed.adjustedKelly - adjExpected) > 0.001) {
          throw new Error(`${check.path} adjustedKelly mismatch: got ${parsed.adjustedKelly} expected ~${adjExpected.toFixed(4)}`);
        }
      }

      if (check._instKellyNeg) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (parsed.rawKelly >= 0) throw new Error(`${check.path} rawKelly must be negative for losing edge`);
        if (parsed.cappedKelly !== 0) throw new Error(`${check.path} cappedKelly must be 0 for negative edge`);
        if (parsed.edgePositive !== false) throw new Error(`${check.path} edgePositive must be false`);
      }

      if (check._instScenario) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false: ${JSON.stringify(parsed)}`);
        if (!parsed.auditId)                        throw new Error(`${check.path} missing auditId`);
        if (!parsed.scenarioId)                     throw new Error(`${check.path} missing scenarioId`);
        if (typeof parsed.totalPnlImpact !== 'number') throw new Error(`${check.path} missing totalPnlImpact`);
        if (typeof parsed.drawdownPct !== 'number') throw new Error(`${check.path} missing drawdownPct`);
        if (!Array.isArray(parsed.details))         throw new Error(`${check.path} missing details array`);
        if (parsed.details.length !== 2)            throw new Error(`${check.path} expected 2 position details`);
        // SPY: 100 × 500 × -0.20 = -10000
        const spyDetail = parsed.details.find((d) => d.symbol === 'SPY');
        if (!spyDetail) throw new Error(`${check.path} missing SPY in details`);
        if (Math.abs(spyDetail.pnlImpact - (-10000)) > 1) {
          throw new Error(`${check.path} SPY pnlImpact wrong: got ${spyDetail.pnlImpact} expected -10000`);
        }
        // QQQ: 50 × 450 × -0.25 = -5625
        const qqqDetail = parsed.details.find((d) => d.symbol === 'QQQ');
        if (Math.abs(qqqDetail.pnlImpact - (-5625)) > 1) {
          throw new Error(`${check.path} QQQ pnlImpact wrong: got ${qqqDetail.pnlImpact} expected -5625`);
        }
        // drawdownPct = totalPnlImpact / accountSize * 100 = -15625 / 100000 * 100 = -15.625
        if (Math.abs(parsed.drawdownPct - (-15.625)) > 0.01) {
          throw new Error(`${check.path} drawdownPct wrong: got ${parsed.drawdownPct} expected -15.625`);
        }
        // Inject scenario fetch
        checks.push({ method: 'GET', path: `/api/institutional/scenarios/${parsed.scenarioId}`, _instScenGet: true });
        // Inject export with these auditIds
        checks.push({
          method: 'POST', path: '/api/institutional/report/export',
          body: { auditIds: [parsed.auditId], accountSize: 100000, mode: 'paper', title: 'Smoke Scenario Report' },
          _instExportWithAudit: true,
        });
      }

      if (check._instStressPack) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false: ${JSON.stringify(parsed)}`);
        if (parsed.packId !== 'covid_2020')             throw new Error(`${check.path} wrong packId`);
        if (!parsed.auditId)                            throw new Error(`${check.path} missing auditId`);
        if (typeof parsed.totalPnlImpact !== 'number')  throw new Error(`${check.path} missing totalPnlImpact`);
        if (!Array.isArray(parsed.details))             throw new Error(`${check.path} missing details`);
        if (!parsed.name)                               throw new Error(`${check.path} missing name`);
        // SPY shock in covid_2020 = -0.34 → pnlImpact = 100 × 500 × -0.34 = -17000
        const spyD = parsed.details.find((d) => d.symbol === 'SPY');
        if (!spyD) throw new Error(`${check.path} SPY missing in details`);
        if (Math.abs(spyD.pnlImpact - (-17000)) > 1) throw new Error(`${check.path} SPY covid shock wrong: ${spyD.pnlImpact}`);
        // TLT shock in covid_2020 = +0.15 → 50 × 100 × 0.15 = 750
        const tltD = parsed.details.find((d) => d.symbol === 'TLT');
        if (!tltD) throw new Error(`${check.path} TLT missing in details`);
        if (Math.abs(tltD.pnlImpact - 750) > 1) throw new Error(`${check.path} TLT covid shock wrong: ${tltD.pnlImpact}`);
        // mode must be paper
        if (parsed.mode !== 'paper') throw new Error(`${check.path} mode must be paper`);
      }

      if (check._instAudit) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.entries)) throw new Error(`${check.path} missing entries array`);
        if (typeof parsed.count !== 'number') throw new Error(`${check.path} missing count`);
        if (parsed.entries.length > 0) {
          const e = parsed.entries[0];
          if (!e.auditId)      throw new Error(`${check.path} audit entry missing auditId`);
          if (!e.timestamp)    throw new Error(`${check.path} audit entry missing timestamp`);
          if (!e.analysisType) throw new Error(`${check.path} audit entry missing analysisType`);
          if (!e.mode)         throw new Error(`${check.path} audit entry missing mode`);
          if (e.inputs == null) throw new Error(`${check.path} audit entry missing inputs`);
          if (e.outputs == null) throw new Error(`${check.path} audit entry missing outputs`);
        }
      }

      if (check._instAuditGet) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.entry?.auditId)      throw new Error(`${check.path} missing entry.auditId`);
        if (!parsed.entry?.inputs)       throw new Error(`${check.path} missing entry.inputs`);
        if (!parsed.entry?.outputs)      throw new Error(`${check.path} missing entry.outputs`);
        if (!parsed.entry?.engineVersion) throw new Error(`${check.path} missing engineVersion in entry`);
      }

      if (check._instScenGet) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.scenario?.scenarioId) throw new Error(`${check.path} missing scenario.scenarioId`);
        if (!parsed.scenario?.results)    throw new Error(`${check.path} missing scenario.results`);
      }

      if (check._instExport) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.report?.reportId)     throw new Error(`${check.path} missing report.reportId`);
        if (!parsed.report?.reportVersion) throw new Error(`${check.path} missing report.reportVersion`);
        if (!parsed.report?.assumptions)  throw new Error(`${check.path} missing report.assumptions`);
        if (!parsed.report?.assumptions?.formulaDefinitions) throw new Error(`${check.path} report missing formulaDefinitions`);
        if (!parsed.report?.summary)      throw new Error(`${check.path} missing report.summary`);
        if (!Array.isArray(parsed.report?.auditTrail)) throw new Error(`${check.path} missing report.auditTrail`);
        if (parsed.report.mode !== 'paper')  throw new Error(`${check.path} report mode must be paper`);
        if (!parsed.exportAuditId)           throw new Error(`${check.path} missing exportAuditId`);
      }

      if (check._instExportWithAudit) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (parsed.report?.summary?.auditEntriesReferenced !== 1) {
          throw new Error(`${check.path} report should reference exactly 1 audit entry, got ${parsed.report?.summary?.auditEntriesReferenced}`);
        }
        if (parsed.report?.summary?.scenarioAnalyses !== 1) {
          throw new Error(`${check.path} report should have 1 scenarioAnalysis`);
        }
        if (parsed.report?.summary?.worstCasePnl == null) throw new Error(`${check.path} missing worstCasePnl`);
      }

      if (check._instBadPack) {
        if (response.status !== 400) throw new Error(`${check.path} unknown packId must return 400, got ${response.status}`);
        if (!parsed.error) throw new Error(`${check.path} error message missing`);
      }

      // ── Phase 15: Observability / Platform Hardening checks ──────────────────
      if (check._obsHealth) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.uptime?.secs !== 'number')        throw new Error(`${check.path} missing uptime.secs`);
        if (!parsed.memory?.heapUsedMB)                    throw new Error(`${check.path} missing memory.heapUsedMB`);
        if (!parsed.marketSession)                         throw new Error(`${check.path} missing marketSession`);
        if (parsed.marketSession.isOpen == null)           throw new Error(`${check.path} marketSession.isOpen missing`);
        if (!parsed.marketSession.session)                 throw new Error(`${check.path} marketSession.session missing`);
        if (!parsed.websocket)                             throw new Error(`${check.path} missing websocket`);
        if (parsed.websocket.connectedClients == null)     throw new Error(`${check.path} websocket.connectedClients missing`);
        if (!parsed.requests || parsed.requests.total == null) throw new Error(`${check.path} missing requests.total`);
        if (!parsed.rateLimit || parsed.rateLimit.max == null)  throw new Error(`${check.path} missing rateLimit.max`);
        // Verify X-Trace-Id header is present
        if (!response.headers.get('x-trace-id')) throw new Error(`${check.path} X-Trace-Id header missing`);
        // Verify X-RateLimit-Limit header is present
        if (!response.headers.get('x-ratelimit-limit')) throw new Error(`${check.path} X-RateLimit-Limit header missing`);
      }

      if (check._obsMetrics) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.totalRequests !== 'number') throw new Error(`${check.path} missing totalRequests`);
        if (typeof parsed.totalErrors !== 'number')   throw new Error(`${check.path} missing totalErrors`);
        if (!Array.isArray(parsed.routes))            throw new Error(`${check.path} missing routes array`);
        if (typeof parsed.uptimeSecs !== 'number')    throw new Error(`${check.path} missing uptimeSecs`);
        if (parsed.totalRequests === 0) throw new Error(`${check.path} totalRequests must be > 0 after prior smoke requests`);
      }

      if (check._obsMetricsReset) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
      }

      if (check._obsMarketSession) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (parsed.isOpen == null)    throw new Error(`${check.path} missing isOpen`);
        if (!parsed.session)          throw new Error(`${check.path} missing session`);
        if (!parsed.etTime)           throw new Error(`${check.path} missing etTime`);
        if (!parsed.dayName)          throw new Error(`${check.path} missing dayName`);
        if (parsed.overrideActive == null) throw new Error(`${check.path} missing overrideActive`);
        const validSessions = ['regular', 'pre-market', 'after-hours', 'closed', 'weekend'];
        if (!validSessions.includes(parsed.session)) throw new Error(`${check.path} invalid session: ${parsed.session}`);
      }

      if (check._obsWsStats) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (parsed.connectedClients == null)  throw new Error(`${check.path} missing connectedClients`);
        if (!parsed.adapterType)              throw new Error(`${check.path} missing adapterType`);
        if (!parsed.scalingNote)              throw new Error(`${check.path} missing scalingNote`);
        if (!Array.isArray(parsed.upgradeSteps)) throw new Error(`${check.path} missing upgradeSteps array`);
        if (parsed.upgradeSteps.length === 0) throw new Error(`${check.path} upgradeSteps must be non-empty`);
      }

      if (check._obsFailoverDrill) {
        if (!parsed.ok && parsed.drillPass === undefined) throw new Error(`${check.path} missing drillPass field`);
        if (!Array.isArray(parsed.steps)) throw new Error(`${check.path} missing steps array`);
        if (parsed.steps.length < 3)      throw new Error(`${check.path} drill must have >= 3 steps`);
        const step1 = parsed.steps.find((s) => s.step === 1);
        if (!step1?.ok) throw new Error(`${check.path} drill step 1 (capture provider chain) failed`);
        if (!Array.isArray(step1.providerOrder)) throw new Error(`${check.path} step 1 missing providerOrder`);
        const step3 = parsed.steps.find((s) => s.step === 3);
        if (!step3?.ok) throw new Error(`${check.path} drill step 3 (provider health check) failed`);
        if (!parsed.timestamp) throw new Error(`${check.path} missing timestamp`);
        if (typeof parsed.totalMs !== 'number') throw new Error(`${check.path} missing totalMs`);
      }

      if (check._obsRateLimit) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.globalMax !== 'number') throw new Error(`${check.path} missing globalMax`);
        if (typeof parsed.strictMax !== 'number') throw new Error(`${check.path} missing strictMax`);
        if (typeof parsed.windowMs !== 'number')  throw new Error(`${check.path} missing windowMs`);
        if (parsed.globalMax <= 0) throw new Error(`${check.path} globalMax must be positive`);
        if (parsed.strictMax  <= 0) throw new Error(`${check.path} strictMax must be positive`);
      }

      if (check._obsSessionGuardPaper) {
        // Paper mode is never blocked by the market session guard (only live mode can be).
        // Risk engine rejections (concentration, kill switch, etc.) are acceptable here.
        if (!parsed.ok && parsed.error && String(parsed.error).toLowerCase().includes('session')) {
          throw new Error(`${check.path} paper mode rejected by market session guard (must never happen): ${JSON.stringify(parsed)}`);
        }
      }

      if (check._obsSessionGuardLive) {
        // Live mode must return 422 (either from session guard or risk gate — both are expected blocks)
        if (response.status !== 422) throw new Error(`${check.path} live order outside hours must return 422, got ${response.status}`);
      }

      // ── Phase 13: Multi-Asset Analytics checks ───────────────────────────────
      if (check._maCorr) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.matrix !== 'object') throw new Error(`${check.path} missing matrix`);
        if (!Array.isArray(parsed.symbols)) throw new Error(`${check.path} missing symbols array`);
        if (typeof parsed.window !== 'number') throw new Error(`${check.path} missing window`);
        // Diagonal must be 1.0
        for (const sym of parsed.symbols) {
          if (parsed.matrix[sym]?.[sym] !== 1.0) throw new Error(`${check.path} diagonal must be 1.0 for ${sym}`);
        }
        // Off-diagonal must be number or null (not undefined)
        for (const symA of parsed.symbols) {
          for (const symB of parsed.symbols) {
            const v = parsed.matrix[symA]?.[symB];
            if (symA !== symB && v !== null && (typeof v !== 'number' || v < -1 - 1e-6 || v > 1 + 1e-6)) {
              throw new Error(`${check.path} correlation out of [-1,1] range for ${symA}/${symB}: ${v}`);
            }
          }
        }
      }

      if (check._maBeta) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.benchmark) throw new Error(`${check.path} missing benchmark`);
        if (!Array.isArray(parsed.symbols)) throw new Error(`${check.path} missing symbols array`);
        if (typeof parsed.beta !== 'object') throw new Error(`${check.path} missing beta object`);
        for (const sym of parsed.symbols) {
          const entry = parsed.beta[sym];
          if (!entry) throw new Error(`${check.path} missing beta entry for ${sym}`);
          if (!Array.isArray(entry.rollingBeta)) throw new Error(`${check.path} ${sym} missing rollingBeta array`);
          if (typeof entry.dataPoints !== 'number') throw new Error(`${check.path} ${sym} missing dataPoints`);
        }
      }

      if (check._maSector) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!Array.isArray(parsed.sectors)) throw new Error(`${check.path} missing sectors array`);
        if (parsed.sectors.length === 0) throw new Error(`${check.path} sectors array is empty`);
        if (!parsed.benchmark) throw new Error(`${check.path} missing benchmark`);
        if (typeof parsed.window !== 'number') throw new Error(`${check.path} missing window`);
        for (const s of parsed.sectors) {
          if (!s.sector) throw new Error(`${check.path} sector entry missing sector name`);
          if (!s.etf) throw new Error(`${check.path} sector entry missing etf`);
          if (typeof s.cumReturn !== 'number') throw new Error(`${check.path} ${s.etf} missing cumReturn`);
          if (typeof s.score !== 'number') throw new Error(`${check.path} ${s.etf} missing score`);
        }
        // Confirm sorted by score descending
        for (let i = 1; i < parsed.sectors.length; i++) {
          if (parsed.sectors[i].score > parsed.sectors[i - 1].score) {
            throw new Error(`${check.path} sectors not sorted by score desc at index ${i}`);
          }
        }
      }

      if (check._maVol) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.heatmap !== 'object') throw new Error(`${check.path} missing heatmap`);
        if (!Array.isArray(parsed.symbols)) throw new Error(`${check.path} missing symbols array`);
        for (const sym of parsed.symbols) {
          const entry = parsed.heatmap[sym];
          if (!entry) throw new Error(`${check.path} missing heatmap entry for ${sym}`);
          if (!Array.isArray(entry.rollingVol)) throw new Error(`${check.path} ${sym} missing rollingVol array`);
          if (typeof entry.volRank !== 'number') throw new Error(`${check.path} ${sym} missing volRank`);
        }
        // volRank must be 1..N with no duplicates
        const ranks = parsed.symbols.map((s) => parsed.heatmap[s]?.volRank);
        const sorted = [...ranks].sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i++) {
          if (sorted[i] !== i + 1) throw new Error(`${check.path} volRank not a contiguous 1..N sequence`);
        }
      }

      if (check._maHeatmap) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (typeof parsed.correlation !== 'object') throw new Error(`${check.path} missing correlation matrix`);
        if (typeof parsed.volatility !== 'object') throw new Error(`${check.path} missing volatility heatmap`);
        if (!Array.isArray(parsed.symbols)) throw new Error(`${check.path} missing symbols array`);
        if (typeof parsed.window !== 'number') throw new Error(`${check.path} missing window`);
      }

      if (check._maRelPerf) {
        if (!parsed.ok) throw new Error(`${check.path} returned ok:false`);
        if (!parsed.benchmark) throw new Error(`${check.path} missing benchmark`);
        if (!Array.isArray(parsed.symbols)) throw new Error(`${check.path} missing symbols array`);
        if (typeof parsed.performance !== 'object') throw new Error(`${check.path} missing performance object`);
        for (const sym of parsed.symbols) {
          const entry = parsed.performance[sym];
          if (!entry) throw new Error(`${check.path} missing performance entry for ${sym}`);
          if (typeof entry.totalReturn !== 'number') throw new Error(`${check.path} ${sym} missing totalReturn`);
          if (typeof entry.relativeReturn !== 'number') throw new Error(`${check.path} ${sym} missing relativeReturn`);
          if (!Array.isArray(entry.cumSeries)) throw new Error(`${check.path} ${sym} missing cumSeries array`);
          if (entry.cumSeries.length > 0) {
            const first = entry.cumSeries[0];
            if (first.asset !== 100 || first.benchmark !== 100) throw new Error(`${check.path} ${sym} cumSeries must start at 100`);
          }
        }
      }

      console.log(`OK ${check.method} ${path}`);
    }
  } finally {
    server.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
