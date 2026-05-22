import express from 'express';
import cors from 'cors';
import { alertsDB, settingsDB } from './db.js';

const app = express();
const PORT = process.env.PORT || 10000;

// ================== MIDDLEWARE ==================
app.use(express.json({ limit: '500kb' }));

// ================== CORS ==================
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';

app.use(cors({
  origin: ALLOWED_ORIGINS === '*'
    ? '*'
    : ALLOWED_ORIGINS.split(',').map(o => o.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-User-Token'],
}));

// ================== AUTH ==================
const USER_TOKEN = process.env.USER_TOKEN || null;

function requireAuth(req, res, next) {
  if (!USER_TOKEN) return next(); // dev mode

  const provided =
    req.headers['x-user-token'] ||
    req.query.token ||
    null;

  if (provided !== USER_TOKEN) {
    return res.status(401).json({
      error: 'Invalid or missing user token'
    });
  }

  next();
}

// ================== GLOBAL LOGS (DEBUG SAFE) ==================
app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

// ================== HEALTH ==================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'reversal-api',
    uptime: process.uptime(),
    authEnabled: !!USER_TOKEN
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// ================== AUTH TEST ==================
app.get('/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// ================== SIMPLE CACHE ==================
const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '30000');

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;

  if (Date.now() - item.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });

  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

// ================== FETCH HELPER ==================
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(id);
  }
}

// ================== YAHOO PROXY ==================
const VALID_SYMBOL = /^[\w\^\.\-=]+$/;
const VALID_INTERVAL = /^(1m|5m|15m|30m|1h|1d)$/;
const VALID_RANGE = /^(1d|5d|1mo|3mo|1y)$/;

app.get('/yahoo/chart/:symbol', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.params;
    const interval = req.query.interval || '5m';
    const range = req.query.range || '1d';

    if (!VALID_SYMBOL.test(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }

    if (!VALID_INTERVAL.test(interval)) {
      return res.status(400).json({ error: 'Invalid interval' });
    }

    if (!VALID_RANGE.test(range)) {
      return res.status(400).json({ error: 'Invalid range' });
    }

    const cacheKey = `${symbol}:${interval}:${range}`;
    const cached = getCache(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;

    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Yahoo error ${response.status}`);
    }

    const data = await response.json();
    setCache(cacheKey, data);

    res.json({ ...data, cached: false });

  } catch (err) {
    console.error('Yahoo error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================== ALERTS ==================
app.post('/alerts', requireAuth, (req, res) => {
  try {
    const alert = req.body;

    if (!alert.symbol || !alert.decision) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    alertsDB.insert(alert);
    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/alerts', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    res.json({ alerts: alertsDB.list(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/alerts', requireAuth, (req, res) => {
  try {
    const result = alertsDB.clear();
    res.json({ ok: true, deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== SETTINGS ==================
const VALID_KEY = /^[a-zA-Z0-9_\-]{1,64}$/;

app.get('/settings/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;

    if (!VALID_KEY.test(key)) {
      return res.status(400).json({ error: 'Invalid key' });
    }

    const value = settingsDB.get(key);
    res.json({ key, value });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/settings/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;

    if (!VALID_KEY.test(key)) {
      return res.status(400).json({ error: 'Invalid key' });
    }

    settingsDB.set(key, req.body?.value);
    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================== START SERVER ==================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Reversal API running on port ${PORT}`);
  console.log(`🔐 Auth: ${USER_TOKEN ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🌍 CORS: ${ALLOWED_ORIGINS}`);
});