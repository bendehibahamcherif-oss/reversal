import express from 'express';
import cors from 'cors';
import http from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Server } from 'socket.io';
import { alertsDB, settingsDB, usersDB } from './db.js';

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || process.env.USER_TOKEN || 'dev-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

app.use(express.json({ limit: '500kb' }));

const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || '*';
const allowedOrigins = ALLOWED_ORIGINS_RAW === '*'
  ? '*'
  : ALLOWED_ORIGINS_RAW.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-User-Token', 'Authorization'],
}));

const USER_TOKEN = process.env.USER_TOKEN || null;

function signUser(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function verifyJwt(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function requireAuth(req, res, next) {
  const bearer = getBearerToken(req);
  if (bearer) {
    const payload = verifyJwt(bearer);
    if (payload) { req.user = payload; return next(); }
  }

  if (!USER_TOKEN) return next();
  const provided = req.headers['x-user-token'] || req.query.token;
  if (provided === USER_TOKEN) return next();

  return res.status(401).json({ error: 'Invalid or missing user token' });
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const provided = req.headers['x-user-token'] || req.query.token;
  if (USER_TOKEN && provided === USER_TOKEN) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function getSocketToken(socket) {
  const bearer = socket.handshake.auth?.jwt || socket.handshake.auth?.token;
  const header = socket.handshake.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return bearer || socket.handshake.headers['x-user-token'] || socket.handshake.query?.token;
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'], allowedHeaders: ['X-User-Token', 'Authorization'] },
});

io.use((socket, next) => {
  const token = getSocketToken(socket);
  if (!token && !USER_TOKEN) return next();
  if (token && verifyJwt(token)) return next();
  if (USER_TOKEN && token === USER_TOKEN) return next();
  return next(new Error('Invalid or missing auth token'));
});

const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL_MS || '30000', 10);

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 500) {
    [...cache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp).slice(0, 250).forEach(([key]) => cache.delete(key));
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'reversal-proxy', version: '3.1-admin-users', authEnabled: !!USER_TOKEN, jwtEnabled: true,
    cors: ALLOWED_ORIGINS_RAW, cacheSize: cache.size, cacheTTLms: CACHE_TTL, uptimeSeconds: Math.floor(process.uptime()),
    publicEndpoints: ['GET /health', 'POST /auth/register', 'POST /auth/login', 'GET /yahoo/chart/:symbol', 'GET /live/snapshot/:symbol', 'POST /signals/generate', 'GET /intelligence/events'],
    protectedEndpoints: ['GET /auth/me', 'GET /auth/check', 'GET /admin/users', 'POST /alerts', 'GET /alerts', 'DELETE /alerts', 'GET /settings/:key', 'PUT /settings/:key'],
    websocket: { eventIn: 'subscribe', eventOut: 'price_update' },
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/auth/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email.includes('@') || password.length < 8) return res.status(400).json({ error: 'Email invalid or password too short' });
    if (usersDB.getByEmail(email)) return res.status(409).json({ error: 'User already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = usersDB.create({ email, passwordHash, role: 'admin' });
    res.json({ token: signUser(user), user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const row = usersDB.getByEmail(email);
    if (!row) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const user = { id: row.id, email: row.email, role: row.role, created_at: row.created_at };
    res.json({ token: signUser(user), user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/auth/me', requireAuth, (req, res) => {
  if (req.user?.sub) return res.json({ user: usersDB.getById(req.user.sub) });
  res.json({ user: { role: 'shared-token', email: null } });
});

app.get('/auth/check', requireAuth, (req, res) => res.json({ ok: true }));
app.get('/admin/users', requireAuth, requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  res.json({ users: usersDB.list(limit) });
});

const VALID_SYMBOL = /^[\w\^\.\-=]+$/;
const VALID_INTERVALS = /^(1m|2m|5m|15m|30m|60m|90m|1h|1d|5d|1wk|1mo|3mo)$/;
const VALID_RANGES = /^(1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max)$/;

async function yahooFetch(symbol, interval = '5m', range = '1d', includePrePost = false) {
  const cacheKey = `${symbol}:${interval}:${range}:${includePrePost ? 1 : 0}`;
  const cached = getCached(cacheKey);
  if (cached) return { data: cached, cached: true };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=${includePrePost ? 'true' : 'false'}`;
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
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
    bars.push({ t: timestamps[i] * 1000, o: quote.open?.[i] ?? null, h: quote.high?.[i] ?? null, l: quote.low?.[i] ?? null, c: quote.close?.[i] ?? null, v: quote.volume?.[i] || 0 });
  }
  return { bars, meta: result.meta };
}

function extractLastPrice(yahooData) {
  const { bars } = extractBars(yahooData);
  const last = bars[bars.length - 1];
  return last ? { price: last.c, timestamp: last.t } : null;
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
  let signal = 'WAIT', confidence = 0.45, reason = 'Neutral intraday setup';
  if (distancePct > 0.6 && changePct < 0) { signal = 'FADE_DOWN'; confidence = Math.min(0.85, 0.55 + Math.abs(distancePct) / 10); reason = 'Price is extended above short-term average and starting to fade'; }
  else if (distancePct < -0.6 && changePct > 0) { signal = 'FADE_UP'; confidence = Math.min(0.85, 0.55 + Math.abs(distancePct) / 10); reason = 'Price is extended below short-term average and starting to bounce'; }
  return { symbol, signal, confidence, reason, price: last.c, changePct, distancePct, timestamp: last.t };
}

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
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/live/snapshot/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const { data } = await yahooFetch(symbol, '1m', '1d');
    const { bars, meta } = extractBars(data);
    res.json({ symbol, last: extractLastPrice(data), signal: simpleSignalFromBars(symbol, bars), meta });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.post('/signals/generate', async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || 'AAPL').toUpperCase().trim();
    if (!VALID_SYMBOL.test(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
    const { data } = await yahooFetch(symbol, '1m', '1d');
    const { bars } = extractBars(data);
    res.json(simpleSignalFromBars(symbol, bars));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/intelligence/events', async (req, res) => res.json({
  events: [
    { type: 'Macro', title: 'FOMC / rates sensitivity watch', impact: 'High', status: 'Monitor USD yields and VIX' },
    { type: 'Earnings', title: 'Large-cap tech earnings window', impact: 'Medium', status: 'Watch post-market gaps' },
    { type: 'Liquidity', title: 'Month-end / options expiry flow', impact: 'Medium', status: 'Positioning can dominate signals' },
  ],
  sentiment: { label: 'Neutral / tactical', score: 0.52 },
}));

io.on('connection', (socket) => {
  console.log('⚡ WebSocket connected:', socket.id);
  socket.data.symbols = ['AAPL'];
  socket.on('subscribe', (payload) => {
    const symbols = Array.isArray(payload?.symbols) ? payload.symbols : [payload?.symbol || 'AAPL'];
    const cleanSymbols = symbols.map(s => String(s).toUpperCase().trim()).filter(s => VALID_SYMBOL.test(s)).slice(0, 20);
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
      } catch (err) { socket.emit('price_error', { symbol, error: err.message }); }
    }
  }
}, 5000);

app.post('/alerts', requireAuth, (req, res) => {
  try {
    const alert = req.body;
    if (!alert.symbol || !alert.decision) return res.status(400).json({ error: 'Missing fields' });
    alertsDB.insert(alert);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/alerts', requireAuth, (req, res) => {
  try { res.json({ alerts: alertsDB.list(Math.min(parseInt(req.query.limit || '200', 10), 1000)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/alerts', requireAuth, (req, res) => {
  try { const result = alertsDB.clear(); res.json({ ok: true, deleted: result.changes }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const VALID_SETTING_KEY = /^[a-zA-Z0-9_\-]{1,64}$/;
app.get('/settings/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;
    if (!VALID_SETTING_KEY.test(key)) return res.status(400).json({ error: 'Invalid key' });
    res.json({ key, value: settingsDB.get(key) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.put('/settings/:key', requireAuth, (req, res) => {
  try {
    const key = req.params.key;
    if (!VALID_SETTING_KEY.test(key)) return res.status(400).json({ error: 'Invalid key' });
    settingsDB.set(key, req.body?.value);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Reversal API + WebSocket running on port ${PORT}`);
  console.log(`🔐 Auth: ${USER_TOKEN ? 'ENABLED' : 'DISABLED'} / JWT ENABLED`);
  console.log(`🌍 CORS: ${ALLOWED_ORIGINS_RAW}`);
});
