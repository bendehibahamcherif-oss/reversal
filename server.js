import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { alertsDB, settingsDB } from './db.js';

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '500kb' }));

// ============ CORS ============
const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || '*';

app.use(cors({
  origin: ALLOWED_ORIGINS_RAW === '*'
    ? '*'
    : ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-User-Token'],
}));

// ============ AUTH ============
const USER_TOKEN = process.env.USER_TOKEN || null;

function requireAuth(req, res, next) {
  if (!USER_TOKEN) return next();

  const provided = req.headers['x-user-token'] || req.query.token;

  if (provided !== USER_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing user token' });
  }

  next();
}

// ============ HTTP + SOCKET.IO ============
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS_RAW === '*'
      ? '*'
      : ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()),
    methods: ['GET', 'POST'],
    allowedHeaders: ['X-User-Token'],
  },
});

// WebSocket auth
io.use((socket, next) => {
  if (!USER_TOKEN) return next();

  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers['x-user-token'] ||
    socket.handshake.query?.token;

  if (token !== USER_TOKEN) {
    return next(new Error('Invalid or missing user token'));
  }

  next();
});

// ============ CACHE ============
const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '30000');

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
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ============ HEALTH ============
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'reversal-proxy',
    version: '2.1-websocket',
    authEnabled: !!USER_TOKEN,
    cors: ALLOWED_ORIGINS_RAW,
    cacheSize: cache.size,
    uptimeSeconds: Math.floor(process.uptime()),
    endpoints: [
      'GET /health',
      'GET /auth/check',
      'GET /yahoo/chart/:symbol',
      'POST /alerts',
      'GET /alerts',
      'DELETE /alerts',
      'GET /settings/:key',
      'PUT /settings/:key',
    ],
    websocket: {
      eventIn: 'subscribe',
      eventOut: 'price_update',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/auth/check', requireAuth, (req, res) => {
  res.json({ ok: true });
});

// ============ YAHOO ============
const VALID_SYMBOL = /^[\w\^\.\-=]+$/;
const VALID_INTERVALS = /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/;
const VALID_RANGES = /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/;

async function yahooFetch(symbol, interval = '5m', range = '1d') {
  const cacheKey = `${symbol}:${interval}:${range}`;
  const cached = getCached(cacheKey);

  if (cached) {
    return { data: cached, cached: true };
  }

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${interval}&range=${range}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo ${response.status}`);
  }

  const data = await response.json();
  setCached(cacheKey, data);

  return { data, cached: false };
}

function extractLastPrice(yahooData) {
  const result = yahooData?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0];

  if (!result || !quote || !timestamps.length) return null;

  const close = quote.close || [];

  for (let i = close.length - 1; i >= 0; i--) {
    if (close[i] != null) {
      return {
        price: close[i],
        timestamp: timestamps[i] * 1000,
      };
    }
  }

  return null;
}

app.get('/yahoo/chart/:symbol', requireAuth, async (req, res) => {
  try {
    const { symbol } = req.params;
    const interval = req.query.interval || '5m';
    const range = req.query.range || '1d';

    if (!VALID_SYMBOL.test(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }

    if (!VALID_INTERVALS.test(interval)) {
      return res.status(400).json({ error: 'Invalid interval' });
    }

    if (!VALID_RANGES.test(range)) {
      return res.status(400).json({ error: 'Invalid range' });
    }

    const { data, cached } = await yahooFetch(symbol, interval, range);

    res.set('X-Cache', cached ? 'HIT' : 'MISS');
    res.json(data);
  } catch (err) {
    console.error('Yahoo error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ============ WEBSOCKET LIVE FEED ============
io.on('connection', (socket) => {
  console.log('⚡ WebSocket connected:', socket.id);

  socket.data.symbols = ['AAPL'];

  socket.on('subscribe', (payload) => {
    const symbols = Array.isArray(payload?.symbols)
      ? payload.symbols
      : [payload?.symbol || 'AAPL'];

    const cleanSymbols = symbols
      .map(s => String(s).toUpperCase().trim())
      .filter(s => VALID_SYMBOL.test(s))
      .slice(0, 20);

    socket.data.symbols = cleanSymbols.length ? cleanSymbols : ['AAPL'];

    socket.emit('subscribed', {
      symbols: socket.data.symbols,
    });
  });

  socket.on('disconnect', () => {
    console.log('❌ WebSocket disconnected:', socket.id);
  });
});

setInterval(async () => {
  const sockets = await io.fetchSockets();

  for (const socket of sockets) {
    const symbols = socket.data.symbols || ['AAPL'];

    for (const symbol of symbols) {
      try {
        const { data } = await yahooFetch(symbol, '1m', '1d');
        const last = extractLastPrice(data);

        if (!last) continue;

        socket.emit('price_update', {
          symbol,
          price: last.price,
          timestamp: last.timestamp,
        });
      } catch (err) {
        socket.emit('price_error', {
          symbol,
          error: err.message,
        });
      }
    }
  }
}, 5000);

// ============ ALERTS ============
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

// ============ SETTINGS ============
const VALID_SETTING_KEY = /^[a-zA-Z0-9_\-]{1,64}$/;

app.get('/settings/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;

    if (!VALID_SETTING_KEY.test(key)) {
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

    if (!VALID_SETTING_KEY.test(key)) {
      return res.status(400).json({ error: 'Invalid key' });
    }

    settingsDB.set(key, req.body?.value);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ START ============
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Reversal API + WebSocket running on port ${PORT}`);
  console.log(`🔐 Auth: ${USER_TOKEN ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🌍 CORS: ${ALLOWED_ORIGINS_RAW}`);
});