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
const allowedOrigins = ALLOWED_ORIGINS_RAW === '*'
  ? '*'
  : ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
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
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['X-User-Token'],
  },
});

io.use((socket, next) => {
  if (!USER_TOKEN) return next();
  const token = socket.handshake.auth?.token || socket.handshake.headers['x-user-token'] || socket.handshake.query?.token;
  if (token !== USER_TOKEN) return next(new Error('Invalid or missing user token'));
  next();
});

// ============ CACHE ============
const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '30000', 10);

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
    [...cache.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, 250)
      .forEach(([key]) => cache.delete(key));
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
    version: '2.2-bloomberg-lite-foundation',
    authEnabled: !!USER_TOKEN,
    cors: ALLOWED_ORIGINS_RAW,
    cacheSize: cache.size,
    cacheTTLms: CACHE_TTL,
    uptimeSeconds: Math.floor(process.uptime()),
    publicEndpoints: [
      'GET /health',
      'GET /yahoo/chart/:symbol',
      'GET /live/snapshot/:symbol',
      'POST /signals/generate',
    ],
    protectedEndpoints: [
      'GET /auth/check',
      'POST /alerts',
      'GET /alerts',
      'DELETE /alerts',
      'GET /settings/:key',
      'PUT /settings/:key',
    ],
    websocket: { eventIn: 'subscribe', eventOut: 'price_update' },
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/auth/check', requireAuth, (req, res) => res.json({ ok: true }));

// ============ MARKET DATA ============
const VALID_SYMBOL = /^[\w\^\.\-=]+$/;
const VALID_INTERVALS = /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/;
const VALID_RANGES = /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/;

async function yahooFetch(symbol, interval = '5m', range = '1d', includePrePost = false) {
  const cacheKey = `${symbol}:${interval}:${range}:${includePrePost ? 1 : 0}`;
  const cached = getCached(cacheKey);
  if (cached) return { data: cached, cached: true };

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=${encodeURIComponent(interval)}` +
    `&range=${encodeURIComponent(range)}` +
    `&includePrePost=${includePrePost ? 'true' : 'false'}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) throw new Error(`Yahoo ${response.status}`);

  const data = await response.json();
  setCached(cacheKey, data);
  return { data, cached: false };
}

function extractBars(yahooData) {
  const result = yahooData?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0];
  if (!result || !quote || !timestamps.length) return { bars: [], meta: result?.meta || null };

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.close?.[i] == null) continue;
    bars.push({
      t: timestamps[i] * 1000,
      o: quote.open?.[i] ?? null,
      h: quote.high?.[i] ?? null,
      l: quote.low?.[i] ?? null,
      c: quote.close?.[i] ?? null,
      v: quote.volume?.[i] || 0,
    });
  }
  return { bars, meta: result.meta };
}

function extractLastPrice(yahooData) {
  const { bars } = extractBars(yahooData);
  const last = bars[bars.length - 1];
  if (!last) return null;
  return { price: last.c, timestamp: last.t };
}

function simpleSignalFromBars(symbol, bars) {
  if (!bars.length) return { symbol, signal: 'WAIT', confidence: 0, reason: 'No bars available' };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const closes = bars.map(b => b.c).filter(v => v != null);
  const changePct = prev.c ? ((last.c - prev.c) / prev.c) * 100 : 0;
  const window = closes.slice(-20);
  const avg = window.reduce((a, b) => a + b, 0) / Math.max(window.length, 1);
  const distancePct = avg ? ((last.c - avg) / avg) * 100 : 0;

  let signal = 'WAIT';
  let confidence = 0.45;
  let reason = 'Neutral intraday setup';

  if (distancePct > 0.6 && changePct < 0) {
    signal = 'FADE_DOWN';
    confidence = Math.min(0.85, 0.55 + Math.abs(distancePct) / 10);
    reason = 'Price is extended above short-term average and starting to fade';
  } else if (distancePct < -0.6 && changePct > 0) {
    signal = 'FADE_UP';
    confidence = Math.min(0.85, 0.55 + Math.abs(distancePct) / 10);
    reason = 'Price is extended below short-term average and starting to bounce';
  }

  return { symbol, signal, confidence, reason, price: last.c, changePct, distancePct, timestamp: last.t };
}

// Public by design: frontend chart loader uses this route without X-User-Token.
app.get('/yahoo/chart/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const interval = req.query.interval || '5m';
    const range = req.query.range || '1d';
    const includePrePost = req.query.includePrePost === 'true';

    if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    if (!VALID_INTERVALS.test(interval)) return res.status(400).json({ error: 'Invalid interval' });
    if (!VALID_RANGES.test(range)) return res.status(400).json({ error: 'Invalid range' });

    const { data, cached } = await yahooFetch(symbol, interval, range, includePrePost);
    res.set('X-Cache', cached ? 'HIT' : 'MISS');
    res.json(data);
  } catch (err) {
    console.error('Yahoo error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/live/snapshot/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const { data } = await yahooFetch(symbol, '1m', '1d');
    const { bars, meta } = extractBars(data);
    const last = extractLastPrice(data);
    res.json({ symbol, last, signal: simpleSignalFromBars(symbol, bars), meta });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/signals/generate', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || 'AAPL').toUpperCase().trim();
    if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const { data } = await yahooFetch(symbol, '1m', '1d');
    const { bars } = extractBars(data);
    res.json(simpleSignalFromBars(symbol, bars));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ============ WEBSOCKET LIVE FEED ============
io.on('connection', (socket) => {
  console.log('⚡ WebSocket connected:', socket.id);
  socket.data.symbols = ['AAPL'];

  socket.on('subscribe', (payload) => {
    const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [payload?.symbol || 'AAPL'];
    const cleanSymbols = symbols
      .map(s => String(s).toUpperCase().trim())
      .filter(s => VALID_SYMBOL.test(s))
      .slice(0, 20);

    socket.data.symbols = cleanSymbols.length ? cleanSymbols : ['AAPL'];
    socket.emit('subscribed', { symbols: socket.data.symbols });
  });

  socket.on('disconnect', () => console.log('❌ WebSocket disconnected:', socket.id));
});

setInterval(async () => {
  const sockets = await io.fetchSockets();
  if (!sockets.length) return;

  for (const socket of sockets) {
    const symbols = socket.data.symbols || ['AAPL'];
    for (const symbol of symbols) {
      try {
        const { data } = await yahooFetch(symbol, '1m', '1d');
        const { bars } = extractBars(data);
        const last = extractLastPrice(data);
        if (!last) continue;
        socket.emit('price_update', { symbol, price: last.price, timestamp: last.timestamp, signal: simpleSignalFromBars(symbol, bars) });
      } catch (err) {
        socket.emit('price_error', { symbol, error: err.message });
      }
    }
  }
}, 5000);

// ============ ALERTS ============
app.post('/alerts', requireAuth, (req, res) => {
  try {
    const alert = req.body;
    if (!alert.symbol || !alert.decision) return res.status(400).json({ error: 'Missing fields' });
    alertsDB.insert(alert);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/alerts', requireAuth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
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
    if (!VALID_SETTING_KEY.test(key)) return res.status(400).json({ error: 'Invalid key' });
    const value = settingsDB.get(key);
    res.json({ key, value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/settings/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;
    if (!VALID_SETTING_KEY.test(key)) return res.status(400).json({ error: 'Invalid key' });
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
