import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 10000;

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
  // Soft cap: when > 500 entries, drop the 250 oldest
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
    endpoints: ['/yahoo/chart/:symbol?interval=5m&range=1d'],
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

// ============ START ============
app.listen(PORT, () => {
  console.log(`Reversal proxy listening on port ${PORT}`);
  console.log(`CORS origins: ${ALLOWED_ORIGINS_RAW}`);
  console.log(`Cache TTL: ${CACHE_TTL}ms`);
});
