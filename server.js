import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '500kb' }));

// ============ CORS CONFIG ============
const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || '*';
const corsOptions = ALLOWED_ORIGINS_RAW === '*'
  ? { origin: '*' }
  : { origin: ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()) };
app.use(cors(corsOptions));

// ============ CACHE ============
const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS) || 30000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 500) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    sorted.slice(0, 250).forEach(([k]) => cache.delete(k));
  }
}

// ============ FETCH WITH TIMEOUT ============
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// ============ HEALTH / ROOT ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'reversal-engine-proxy',
    cacheSize: cache.size,
    cacheTTLms: CACHE_TTL,
    uptimeSeconds: Math.floor(process.uptime()),
    claudeConfigured: !!process.env.ANTHROPIC_API_KEY,
    endpoints: [
      '/yahoo/chart/:symbol?interval=5m&range=1d',
      '/claude/status',
      'POST /claude/analyze',
    ],
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ============ YAHOO PROXY ============
const VALID_INTERVALS = /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/;
const VALID_RANGES = /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/;
const VALID_SYMBOL = /^[\w\^\.\-=]+$/;

app.get('/yahoo/chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol;
  const interval = req.query.interval || '5m';
  const range = req.query.range || '1d';

  if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (!VALID_INTERVALS.test(interval)) return res.status(400).json({ error: 'Invalid interval' });
  if (!VALID_RANGES.test(range)) return res.status(400).json({ error: 'Invalid range' });

  const cacheKey = `${symbol}:${interval}:${range}`;
  const cached = getCached(cacheKey);
  if (cached) {
    res.set('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    const upstreamUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
    const response = await fetchWithTimeout(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      console.error(`Yahoo ${response.status} for ${cacheKey}`);
      return res.status(response.status).json({ error: `Upstream returned ${response.status}` });
    }

    const data = await response.json();
    setCached(cacheKey, data);
    res.set('X-Cache', 'MISS');
    res.json(data);
  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ============ CLAUDE PROXY ============
const VALID_MODELS = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

// Lightweight rate limiter: max N analyses per minute per IP
const rateLimits = new Map();
const RATE_LIMIT_MAX = parseInt(process.env.CLAUDE_RATE_LIMIT_PER_MIN) || 10;
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = rateLimits.get(ip) || [];
  const recent = arr.filter(t => now - t < windowMs);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  rateLimits.set(ip, recent);
  return true;
}

app.get('/claude/status', (req, res) => {
  res.json({
    configured: !!process.env.ANTHROPIC_API_KEY,
    rateLimitPerMin: RATE_LIMIT_MAX,
  });
});

function buildAnalysisPrompt(ctx) {
  const fmt = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));
  const tfLine = (k, t) => {
    if (!t) return `${k}: —`;
    return `${k}: prix ${fmt(t.last)}, RSI ${fmt(t.rsi, 1)}, trend ${t.trend}, ${t.changePct >= 0 ? '+' : ''}${fmt(t.changePct, 2)}%`;
  };
  const tfLines = ['1m', '5m', '15m', '30m', '1h', '1d']
    .map(k => tfLine(k, ctx.tfIndicators?.[k]))
    .join('\n');

  return `Tu es un analyste quantitatif spécialisé en stratégies contrarian intraday sur options (3M ATM, gap fade).

CONTEXTE DU MARCHÉ — ${ctx.ticker}
- Prix: ${fmt(ctx.currentPrice)} (${ctx.priceSource || 'N/A'}${ctx.priceTimestamp ? ` à ${new Date(ctx.priceTimestamp * 1000).toLocaleTimeString('fr-FR')}` : ''})
- Clôture référence: ${fmt(ctx.prevClose)}
- Gap: ${ctx.gap >= 0 ? '+' : ''}${fmt(ctx.gap)}$ (${fmt(ctx.gapPct)}%), ratio ${fmt(ctx.gapAtrRatio)}× ATR
- VIX: ${fmt(ctx.vix, 1)}
- Range 1ère heure: ${fmt(ctx.firstHourPctOfDaily, 0)}% du daily moyen
- Direction fade envisagée: ${ctx.direction === 'fade_up' ? 'baissière (puts)' : 'haussière (calls)'}

INDICATEURS MULTI-TIMEFRAME
${tfLines}
- Alignement MTF: ${ctx.mtfAlignment}

MOTEUR BAYÉSIEN
- Probabilité de retournement: ${fmt(ctx.posterior * 100, 1)}%
- Décision: ${ctx.decision}
- Raison: ${ctx.decisionReason}

TÂCHE
Fournis une analyse en 4 sections compactes (max 2-3 phrases chacune, ton de tradeur direct, pas de disclaimers génériques).

**1. Sentiment marché**
Contexte du sous-jacent et de son secteur aujourd'hui. Si tu as accès à la recherche web, vérifie les news récentes pertinentes pour ${ctx.ticker} (catalyseurs, événements, sentiment analyste).

**2. Facteurs spécifiques**
Points particuliers sur ce ticker à surveiller : niveaux techniques clés, catalyseurs à venir (earnings, ex-div, conférences), positionnement options inhabituel, dynamique sectorielle.

**3. Validation du setup quantitatif**
La décision du moteur (${ctx.decision}, ${fmt(ctx.posterior * 100, 1)}%) est-elle cohérente avec le contexte fondamental et technique? Identifier les angles morts éventuels du modèle quantitatif sur ce trade précis.

**4. Recommandation finale**
Confirme ou contredit la décision automatique. Indique ton niveau de confiance: FAIBLE / MODÉRÉ / FORT. Si tu confirmes, suggère un ajustement de taille ou de timing si pertinent.`;
}

app.post('/claude/analyze', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }

  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: `Rate limit: max ${RATE_LIMIT_MAX} analyses/minute` });
  }

  const ctx = req.body || {};
  if (!ctx.ticker || !/^[\w\^\.\-=]+$/.test(ctx.ticker)) {
    return res.status(400).json({ error: 'Invalid or missing ticker' });
  }

  const model = ctx.model && VALID_MODELS.has(ctx.model) ? ctx.model : 'claude-sonnet-4-6';
  const useWebSearch = ctx.useWebSearch !== false;

  const prompt = buildAnalysisPrompt(ctx);

  const body = {
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
  }

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }, 60000); // 60s timeout for web search

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      console.error(`Anthropic ${response.status}:`, errBody);
      return res.status(response.status).json({ error: errBody.error?.message || `Anthropic returned ${response.status}` });
    }

    const data = await response.json();
    const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('\n\n');
    const searchCount = data.content.filter(c => c.type === 'server_tool_use' || c.type === 'web_search_tool_result').length;

    res.json({
      text,
      searchCount,
      usage: data.usage,
      model: data.model,
    });
  } catch (err) {
    console.error('Claude error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ============ START ============
app.listen(PORT, () => {
  console.log(`Reversal proxy listening on port ${PORT}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS_RAW}`);
  console.log(`Cache TTL: ${CACHE_TTL}ms`);
  console.log(`Claude API key: ${process.env.ANTHROPIC_API_KEY ? 'configured ✓' : 'NOT configured ✗'}`);
  console.log(`Claude rate limit: ${RATE_LIMIT_MAX}/min`);
});
