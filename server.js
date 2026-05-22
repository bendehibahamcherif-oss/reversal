import express from 'express';
import cors from 'cors';
import { alertsDB, settingsDB } from './db.js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '500kb' }));


// ============ CORS ============
const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || '*';
const corsOptions = ALLOWED_ORIGINS_RAW === '*'
  ? { origin: '*' }
  : { origin: ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()) };
app.use(cors(corsOptions));

// ============ USER TOKEN AUTH ============
// Simple shared-secret auth: client sends X-User-Token header.
// If USER_TOKEN env var is unset, auth is disabled (dev mode).
const USER_TOKEN = process.env.USER_TOKEN || null;
function requireAuth(req, res, next) {
  console.log("HEADERS:", req.headers);
  console.log("QUERY:", req.query);
  console.log("PROVIDED TOKEN:",    req.headers['x-user-token']);

  if (!USER_TOKEN) return next();
  const provided = req.headers['x-user-token'] || req.query.token;
  if (provided !== USER_TOKEN) return res.status(401).json({ error: 'Invalid or missing user token' });
  next();
}

// ============ CACHE ============
const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 30000;
function getCached(key) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 500) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    sorted.slice(0, 250).forEach(([k]) => cache.delete(k));
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(t); }
}

// ============ ROOT / HEALTH ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'reversal-engine-proxy',
    version: '2.0',
    cacheSize: cache.size,
    cacheTTLms: CACHE_TTL,
    uptimeSeconds: Math.floor(process.uptime()),
    claudeConfigured: !!process.env.ANTHROPIC_API_KEY,
    authEnabled: !!USER_TOKEN,
    endpoints: [
      'GET  /yahoo/chart/:symbol',
      'GET  /claude/status',
      'POST /claude/analyze',
      'POST /alerts (record)',
      'GET  /alerts (list)',
      'DELETE /alerts (clear)',
      'GET  /settings/:key',
      'PUT  /settings/:key',
      'POST /backtest/:symbol',
    ],
  });
});
app.get('/health', (req, res) => res.json({ ok: true }));

// ============ AUTH CHECK ENDPOINT (for client to verify token) ============
app.get('/auth/check', requireAuth, (req, res) => res.json({ ok: true }));

// ============ YAHOO PROXY ============
const VALID_INTERVALS = /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/;
const VALID_RANGES = /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/;
const VALID_SYMBOL = /^[\w\^\.\-=]+$/;

async function yahooFetch(symbol, interval, range, includePrePost = false) {
  const cacheKey = `${symbol}:${interval}:${range}:${includePrePost ? 1 : 0}`;
  const cached = getCached(cacheKey);
  if (cached) return { data: cached, cached: true };

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=${includePrePost}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) throw new Error(`Yahoo ${response.status}`);
  const data = await response.json();
  setCached(cacheKey, data);
  return { data, cached: false };
}

app.get('/yahoo/chart/:symbol', requireAuth, async (req, res) => {
  const { symbol } = req.params;
  const interval = req.query.interval || '5m';
  const range = req.query.range || '1d';
  if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (!VALID_INTERVALS.test(interval)) return res.status(400).json({ error: 'Invalid interval' });
  if (!VALID_RANGES.test(range)) return res.status(400).json({ error: 'Invalid range' });

  try {
    const { data, cached } = await yahooFetch(symbol, interval, range);
    res.set('X-Cache', cached ? 'HIT' : 'MISS');
    res.json(data);
  } catch (err) {
    console.error('Yahoo error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ============ CLAUDE PROXY ============
const VALID_MODELS = new Set([
  'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
]);
const rateLimits = new Map();
const RATE_LIMIT_MAX = parseInt(process.env.CLAUDE_RATE_LIMIT_PER_MIN) || 10;
function checkRateLimit(ip) {
  const now = Date.now();
  const arr = (rateLimits.get(ip) || []).filter(t => now - t < 60_000);
  if (arr.length >= RATE_LIMIT_MAX) return false;
  arr.push(now);
  rateLimits.set(ip, arr);
  return true;
}

app.get('/claude/status', requireAuth, (req, res) => {
  res.json({ configured: !!process.env.ANTHROPIC_API_KEY, rateLimitPerMin: RATE_LIMIT_MAX });
});

function buildAnalysisPrompt(ctx) {
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));
  const tfLine = (k, t) => !t ? `${k}: —` :
    `${k}: prix ${fmt(t.last)}, RSI ${fmt(t.rsi, 1)}, trend ${t.trend}, ${t.changePct >= 0 ? '+' : ''}${fmt(t.changePct, 2)}%`;
  const tfLines = ['1m','5m','15m','30m','1h','1d'].map(k => tfLine(k, ctx.tfIndicators?.[k])).join('\n');
  return `Tu es un analyste quantitatif spécialisé en stratégies contrarian intraday sur options (3M ATM, gap fade).

CONTEXTE — ${ctx.ticker}
- Prix: ${fmt(ctx.currentPrice)} (${ctx.priceSource || 'N/A'}${ctx.priceTimestamp ? ` à ${new Date(ctx.priceTimestamp * 1000).toLocaleTimeString('fr-FR')}` : ''})
- Clôture référence: ${fmt(ctx.prevClose)}
- Gap: ${ctx.gap >= 0 ? '+' : ''}${fmt(ctx.gap)}$ (${fmt(ctx.gapPct)}%), ratio ${fmt(ctx.gapAtrRatio)}× ATR
- VIX: ${fmt(ctx.vix, 1)}
- Range 1ère heure: ${fmt(ctx.firstHourPctOfDaily, 0)}% du daily moyen
- Direction fade: ${ctx.direction === 'fade_up' ? 'baissière (puts)' : 'haussière (calls)'}

MULTI-TIMEFRAME
${tfLines}
- Alignement MTF: ${ctx.mtfAlignment}

MOTEUR BAYÉSIEN
- P(retournement): ${fmt(ctx.posterior * 100, 1)}%
- Décision: ${ctx.decision}
- Raison: ${ctx.decisionReason}

TÂCHE
Analyse en 4 sections compactes (max 2-3 phrases chacune, ton tradeur direct, pas de disclaimers).

**1. Sentiment marché**
Contexte du sous-jacent et de son secteur aujourd'hui. Vérifie les news récentes pertinentes pour ${ctx.ticker} si tu as accès au web search.

**2. Facteurs spécifiques**
Niveaux techniques clés, catalyseurs à venir (earnings, ex-div), positionnement options inhabituel, dynamique sectorielle.

**3. Validation du setup quantitatif**
La décision (${ctx.decision}, ${fmt(ctx.posterior * 100, 1)}%) est-elle cohérente avec le contexte? Angles morts du modèle?

**4. Recommandation finale**
Confirme ou contredit. Confiance: FAIBLE / MODÉRÉ / FORT.`;
}

app.post('/claude/analyze', requireAuth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error: `Rate limit: max ${RATE_LIMIT_MAX}/min` });

  const ctx = req.body || {};
  if (!ctx.ticker || !VALID_SYMBOL.test(ctx.ticker)) return res.status(400).json({ error: 'Invalid ticker' });

  const model = ctx.model && VALID_MODELS.has(ctx.model) ? ctx.model : 'claude-sonnet-4-6';
  const body = {
    model, max_tokens: 4000,
    messages: [{ role: 'user', content: buildAnalysisPrompt(ctx) }],
  };
  if (ctx.useWebSearch !== false) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    }, 60000);

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: errBody.error?.message || `Anthropic ${response.status}` });
    }
    const data = await response.json();
    const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('\n\n');
    const searchCount = data.content.filter(c => c.type === 'server_tool_use' || c.type === 'web_search_tool_result').length;
    res.json({ text, searchCount, usage: data.usage, model: data.model });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ============ ALERTS (PERSISTENT HISTORY) ============
app.post('/alerts', requireAuth, (req, res) => {
  try {
    const a = req.body;
    if (!a.symbol || !a.decision || a.posterior == null) return res.status(400).json({ error: 'Missing fields' });
    alertsDB.insert(a);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/alerts', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json({ alerts: alertsDB.list(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/alerts', requireAuth, (req, res) => {
  try {
    const result = alertsDB.clear();
    res.json({ ok: true, deleted: result.changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ SETTINGS (key-value, cross-device sync) ============
const VALID_SETTING_KEY = /^[a-zA-Z0-9_\-]{1,64}$/;

app.get('/settings/:key', requireAuth, (req, res) => {
  if (!VALID_SETTING_KEY.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  try {
    const value = settingsDB.get(req.params.key);
    res.json({ key: req.params.key, value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/settings/:key', requireAuth, (req, res) => {
  if (!VALID_SETTING_KEY.test(req.params.key)) return res.status(400).json({ error: 'Invalid key' });
  try {
    settingsDB.set(req.params.key, req.body?.value);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ BACKTEST ============
// Replays a strategy over historical data to evaluate edge.
// For each day in the lookback window: simulate gap fade, track outcome.

function parseYahooBars(data) {
  const result = data.chart.result[0];
  const ts = result.timestamp || [];
  const quote = result.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (quote.close[i] == null) continue;
    bars.push({ t: ts[i] * 1000, o: quote.open[i], h: quote.high[i], l: quote.low[i], c: quote.close[i], v: quote.volume[i] || 0 });
  }
  return { bars, meta: result.meta };
}

function computeATR(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function groupBarsByDay(bars) {
  const byDay = new Map();
  for (const b of bars) {
    const day = new Date(b.t).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  return byDay;
}

// Simulate a single trading day:
// - Compute opening range (first 60 min)
// - Determine gap vs previous close
// - If "fade" criteria met, simulate entering at end of 1st hour, with stop at OR extreme + 0.2*ATR, target at mid-OR
// - Walk forward through remaining bars to see if stop or target hit first
// - Returns { outcome: 'win'|'loss'|'no_trade', signals: {...}, posterior, ... }
function simulateDay({ dayBars, prevClose, dailyATR, vixValue, lookbackBars, params }) {
  if (dayBars.length < 30) return { outcome: 'no_trade', reason: 'insufficient_bars' };

  // Opening range = first 60 min (12 x 5min bars)
  const firstHourBars = dayBars.slice(0, 12);
  const orHigh = Math.max(...firstHourBars.map(b => b.h));
  const orLow = Math.min(...firstHourBars.map(b => b.l));
  const entryBar = dayBars[12] || firstHourBars[firstHourBars.length - 1];
  const entryPrice = entryBar.c;
  const remainingBars = dayBars.slice(13);

  // Compute decision
  const gap = entryPrice - prevClose;
  const gapAtrRatio = Math.abs(gap) / dailyATR;
  const orRange = orHigh - orLow;

  // Compute avg daily range over previous ~20 days
  const recentDailyRanges = lookbackBars.slice(-20).map(d => Math.max(...d.map(b => b.h)) - Math.min(...d.map(b => b.l)));
  const avgDailyRange = recentDailyRanges.length ? recentDailyRanges.reduce((a, b) => a + b, 0) / recentDailyRanges.length : 0;
  const orPct = avgDailyRange > 0 ? (orRange / avgDailyRange) * 100 : 0;

  const direction = gap >= 0 ? 'fade_up' : 'fade_down';

  // Hard blocks
  if (gapAtrRatio > 1.5) return { outcome: 'no_trade', reason: 'gap_extreme' };
  if (orPct > 50) return { outcome: 'no_trade', reason: 'trend_day' };
  if (vixValue && vixValue > 30) return { outcome: 'no_trade', reason: 'vix_panic' };

  // Bayesian score (using configurable LRs from params)
  const { lrs } = params;
  let vixLR = 1.0;
  if (vixValue == null) vixLR = 1.0;
  else if (vixValue < 12) vixLR = lrs.vixLow;
  else if (vixValue <= 25) vixLR = lrs.vixOptimal;
  else if (vixValue <= 30) vixLR = lrs.vixCaution;

  const gapLR = gapAtrRatio < 0.5 ? lrs.gapSmall
    : gapAtrRatio < 1.0 ? lrs.gapModerate
    : lrs.gapLarge;

  const trendLR = orPct === 0 ? 1.0
    : orPct < 30 ? lrs.trendLow
    : lrs.trendModerate;

  const prior = 0.55;
  let odds = prior / (1 - prior);
  odds *= vixLR * gapLR * trendLR;
  const posterior = odds / (1 + odds);

  if (posterior < (params.threshold || 0.65)) return { outcome: 'no_trade', reason: 'low_posterior', posterior };

  // Stop and target
  const stopPrice = direction === 'fade_up' ? orHigh + 0.2 * dailyATR : orLow - 0.2 * dailyATR;
  const targetPrice = (orHigh + orLow) / 2;

  // Walk forward
  let exit = null;
  for (const bar of remainingBars) {
    if (direction === 'fade_up') {
      if (bar.h >= stopPrice) { exit = { type: 'stop', price: stopPrice }; break; }
      if (bar.l <= targetPrice) { exit = { type: 'target', price: targetPrice }; break; }
    } else {
      if (bar.l <= stopPrice) { exit = { type: 'stop', price: stopPrice }; break; }
      if (bar.h >= targetPrice) { exit = { type: 'target', price: targetPrice }; break; }
    }
  }
  // Time stop: close at end of day
  if (!exit) exit = { type: 'time', price: remainingBars[remainingBars.length - 1]?.c ?? entryPrice };

  // P&L in % of underlying (fade_up = short, so positive when price drops)
  const pnlPct = direction === 'fade_up'
    ? ((entryPrice - exit.price) / entryPrice) * 100
    : ((exit.price - entryPrice) / entryPrice) * 100;

  return {
    outcome: pnlPct > 0 ? 'win' : 'loss',
    direction, gap, gapAtrRatio, orPct, posterior,
    entryPrice, exitPrice: exit.price, exitType: exit.type, pnlPct,
    vix: vixValue,
  };
}

app.post('/backtest/:symbol', requireAuth, async (req, res) => {
  const symbol = req.params.symbol;
  if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });

  const lookbackMonths = Math.min(parseInt(req.body?.lookbackMonths) || 6, 24);
  const params = {
    threshold: req.body?.threshold ?? 0.65,
    lrs: {
      vixLow: req.body?.lrs?.vixLow ?? 0.9,
      vixOptimal: req.body?.lrs?.vixOptimal ?? 1.4,
      vixCaution: req.body?.lrs?.vixCaution ?? 0.7,
      gapSmall: req.body?.lrs?.gapSmall ?? 1.3,
      gapModerate: req.body?.lrs?.gapModerate ?? 1.5,
      gapLarge: req.body?.lrs?.gapLarge ?? 0.8,
      trendLow: req.body?.lrs?.trendLow ?? 1.5,
      trendModerate: req.body?.lrs?.trendModerate ?? 1.0,
    },
  };

  try {
    // Fetch 5m bars (max range Yahoo allows is 60d for 5m). For longer, we need to chain.
    // Strategy: fetch 5m bars for the requested period, plus daily for ATR/avg range.
    const range = lookbackMonths <= 2 ? `${Math.max(lookbackMonths * 30, 30)}d` : '60d'; // Yahoo limits 5m to 60d
    const actualMonths = lookbackMonths <= 2 ? lookbackMonths : 2;

    const { data: intradayData } = await yahooFetch(symbol, '5m', '60d', false);
    const { data: dailyData } = await yahooFetch(symbol, '1d', '1y', false);
    const { data: vixData } = await yahooFetch('^VIX', '1d', '1y', false).catch(() => ({ data: null }));

    const intraday = parseYahooBars(intradayData);
    const daily = parseYahooBars(dailyData);
    const vix = vixData ? parseYahooBars(vixData) : { bars: [] };

    if (!intraday.bars.length || !daily.bars.length) {
      return res.status(502).json({ error: 'Empty Yahoo data' });
    }

    // Group intraday bars by day
    const intradayByDay = groupBarsByDay(intraday.bars);
    // Map daily close by date
    const dailyByDay = new Map(daily.bars.map(b => [new Date(b.t).toISOString().slice(0, 10), b]));
    const vixByDay = new Map(vix.bars.map(b => [new Date(b.t).toISOString().slice(0, 10), b.c]));

    const sortedDays = [...intradayByDay.keys()].sort();
    const trades = [];

    for (let i = 0; i < sortedDays.length; i++) {
      const day = sortedDays[i];
      const dayBars = intradayByDay.get(day);
      if (!dayBars || dayBars.length < 20) continue;

      const dailyBar = dailyByDay.get(day);
      const prevDailyBar = i > 0 ? dailyByDay.get(sortedDays[i - 1]) : null;
      if (!dailyBar || !prevDailyBar) continue;

      const prevClose = prevDailyBar.c;

      // Compute ATR up to (but not including) this day
      const dailyBarsBefore = daily.bars.filter(b => new Date(b.t).toISOString().slice(0, 10) < day);
      const atr14 = computeATR(dailyBarsBefore.slice(-30), 14);
      if (!atr14) continue;

      // Lookback bars for avg range
      const lookbackDays = sortedDays.slice(Math.max(0, i - 20), i);
      const lookbackBars = lookbackDays.map(d => intradayByDay.get(d) || []);

      const vixValue = vixByDay.get(day) ?? null;

      const result = simulateDay({
        dayBars, prevClose, dailyATR: atr14, vixValue, lookbackBars, params,
      });

      if (result.outcome !== 'no_trade') {
        trades.push({ day, ...result });
      }
    }

    // Statistics
    const wins = trades.filter(t => t.outcome === 'win');
    const losses = trades.filter(t => t.outcome === 'loss');
    const winRate = trades.length ? wins.length / trades.length : 0;
    const avgWin = wins.length ? wins.reduce((a, b) => a + b.pnlPct, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((a, b) => a + b.pnlPct, 0) / losses.length : 0;
    const expectancy = trades.length ? trades.reduce((a, b) => a + b.pnlPct, 0) / trades.length : 0;
    const totalPnl = trades.reduce((a, b) => a + b.pnlPct, 0);
    const profitFactor = (losses.length > 0 && avgLoss !== 0) ? Math.abs((wins.length * avgWin) / (losses.length * avgLoss)) : null;

    // Win rate by signal bucket (used to calibrate LRs)
    const buckets = {
      vix_low: { trades: [], label: 'VIX < 12' },
      vix_optimal: { trades: [], label: 'VIX 12-25' },
      vix_caution: { trades: [], label: 'VIX 25-30' },
      gap_small: { trades: [], label: 'Gap < 0.5×ATR' },
      gap_moderate: { trades: [], label: 'Gap 0.5-1×ATR' },
      gap_large: { trades: [], label: 'Gap 1-1.5×ATR' },
      trend_low: { trades: [], label: 'Range 1H < 30%' },
      trend_moderate: { trades: [], label: 'Range 1H 30-50%' },
    };

    for (const t of trades) {
      if (t.vix != null) {
        if (t.vix < 12) buckets.vix_low.trades.push(t);
        else if (t.vix <= 25) buckets.vix_optimal.trades.push(t);
        else if (t.vix <= 30) buckets.vix_caution.trades.push(t);
      }
      if (t.gapAtrRatio < 0.5) buckets.gap_small.trades.push(t);
      else if (t.gapAtrRatio < 1.0) buckets.gap_moderate.trades.push(t);
      else if (t.gapAtrRatio < 1.5) buckets.gap_large.trades.push(t);

      if (t.orPct < 30) buckets.trend_low.trades.push(t);
      else if (t.orPct < 50) buckets.trend_moderate.trades.push(t);
    }

    const bucketStats = Object.fromEntries(Object.entries(buckets).map(([k, v]) => {
      const n = v.trades.length;
      const w = v.trades.filter(t => t.outcome === 'win').length;
      const wr = n > 0 ? w / n : null;
      // LR = (P(signal|win) / P(signal|loss)) -- approximation: bucket_winrate / (1 - bucket_winrate) * (1 - global_winrate) / global_winrate
      const lr = (wr != null && winRate > 0 && winRate < 1 && wr > 0 && wr < 1)
        ? (wr / (1 - wr)) * ((1 - winRate) / winRate)
        : null;
      return [k, { label: v.label, n, wins: w, winRate: wr, suggestedLR: lr }];
    }));

    res.json({
      symbol,
      lookbackMonths: actualMonths,
      yahooLimit: 'Yahoo 5m bars limited to ~60d. For longer backtests, would need a paid feed.',
      tradesCount: trades.length,
      wins: wins.length, losses: losses.length,
      winRate, avgWin, avgLoss, expectancy, totalPnl, profitFactor,
      bucketStats,
      trades: trades.slice(-50), // last 50 trades for inspection
      params,
    });
  } catch (err) {
    console.error('Backtest error:', err);
    res.status(502).json({ error: err.message });
  }
});

// ============ START ============
app.listen(PORT, () => {
  console.log(`Reversal proxy v2.0 listening on port ${PORT}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS_RAW}`);
  console.log(`Cache TTL: ${CACHE_TTL}ms`);
  console.log(`Claude API: ${process.env.ANTHROPIC_API_KEY ? 'configured ✓' : 'NOT configured ✗'}`);
  console.log(`Claude rate limit: ${RATE_LIMIT_MAX}/min`);
  console.log(`User token auth: ${USER_TOKEN ? 'enabled ✓' : 'DISABLED (set USER_TOKEN env var to enable)'}`);
});
