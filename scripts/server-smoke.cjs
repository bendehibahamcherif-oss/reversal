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
    env: { ...process.env, PORT: String(PORT), MONGO_URI: process.env.MONGO_URI || '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stderr.write(`[server-err] ${d}`));

  try {
    await waitForReady();
    let createdRuleSetId = '';
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
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${check.method} ${check.path} did not return JSON`);
      }

      if (!response.ok && !check._previewNoDisclaimer) {
        throw new Error(`${check.method} ${path} failed with ${response.status}: ${JSON.stringify(parsed)}`);
      }

      if (check.path === '/api/quant/pipeline/SPY' && !Array.isArray(parsed.qualityScores)) {
        throw new Error('POST /api/quant/pipeline/SPY missing qualityScores array');
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
