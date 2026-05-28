const BASE_URL = 'https://api.twelvedata.com';
const TIMEFRAME_MAP = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
};

function normalizeSymbol(symbol = '') {
  const raw = String(symbol || '').trim().toUpperCase();
  return raw;
}

function timeframeToInterval(timeframe = '1m') {
  return TIMEFRAME_MAP[String(timeframe || '1m')] || '1min';
}

async function callTwelveData(endpoint, params, apiKey) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });
  url.searchParams.set('apikey', apiKey);

  const response = await fetch(url.toString());
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorCode = response.status === 429 ? 'rate_limited' : 'http_error';
    return { ok: false, error: { code: errorCode, status: response.status, message: payload?.message || 'request_failed' } };
  }

  if (payload?.status === 'error') {
    const message = String(payload?.message || 'provider_error').toLowerCase();
    const code = message.includes('api credits') || message.includes('frequency') ? 'rate_limited' : 'provider_error';
    return { ok: false, error: { code, message: payload?.message || 'provider_error' } };
  }

  return { ok: true, data: payload };
}

export const twelveDataProvider = {
  id: 'twelvedata',
  name: 'Twelve Data',
  type: 'market_data',
  requiresCredentials: true,
  supportsTicks: true,
  supportsCandles: true,
  supportsOrderBook: false,
  status(credentials = {}) {
    if (!credentials.apiKey) {
      return { status: 'missing_credentials', connected: false, warnings: ['Twelve Data API key not configured.'] };
    }
    return { status: 'configured', connected: false, warnings: [] };
  },
  validateCredentials(credentials = {}) {
    return {
      valid: Boolean(credentials.apiKey),
      warnings: credentials.apiKey ? [] : ['apiKey is required'],
    };
  },
  start() { return { status: 'configured', connected: false }; },
  stop() { return { status: 'stopped', connected: false }; },
  async getLatestTick(symbol, credentials = {}) {
    if (!credentials.apiKey) return null;
    const normalized = normalizeSymbol(symbol);
    const result = await callTwelveData('quote', { symbol: normalized }, credentials.apiKey);
    if (!result.ok) return null;
    const quote = result.data || {};
    const price = Number(quote.close ?? quote.price);
    if (!Number.isFinite(price)) return null;
    return {
      symbol: normalized,
      price,
      bid: Number(quote.bid) || price,
      ask: Number(quote.ask) || price,
      volume: Number(quote.volume) || 0,
      source: 'twelvedata',
      timestamp: quote.datetime ? new Date(quote.datetime).toISOString() : new Date().toISOString(),
      sequence: Date.now() % 1_000_000,
    };
  },
  async getLatestCandle(symbol, timeframe = '1m', credentials = {}) {
    if (!credentials.apiKey) return null;
    const normalized = normalizeSymbol(symbol);
    const interval = timeframeToInterval(timeframe);
    const result = await callTwelveData('time_series', { symbol: normalized, interval, outputsize: 1 }, credentials.apiKey);
    if (!result.ok) return null;
    const candle = Array.isArray(result.data?.values) ? result.data.values[0] : null;
    if (!candle) return null;
    return {
      symbol: normalized,
      timeframe,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume) || 0,
      source: 'twelvedata',
      timestamp: candle.datetime ? new Date(candle.datetime).toISOString() : new Date().toISOString(),
    };
  },
  async getCandles(symbol, timeframe = '1m', limit = 200, credentials = {}) {
    if (!credentials.apiKey) return [];
    const normalized = normalizeSymbol(symbol);
    const interval = timeframeToInterval(timeframe);
    const outputsize = Math.max(1, Math.min(5000, Number(limit) || 200));
    const result = await callTwelveData('time_series', { symbol: normalized, interval, outputsize }, credentials.apiKey);
    if (!result.ok) return [];
    const values = Array.isArray(result.data?.values) ? result.data.values : [];
    return values
      .map((candle) => ({
        symbol: normalized,
        timeframe,
        t: candle.datetime ? Date.parse(candle.datetime) : Date.now(),
        o: Number(candle.open),
        h: Number(candle.high),
        l: Number(candle.low),
        c: Number(candle.close),
        v: Number(candle.volume) || 0,
        source: 'twelvedata',
      }))
      .filter((candle) => Number.isFinite(candle.c) && Number.isFinite(candle.t))
      .sort((a, b) => a.t - b.t)
      .slice(-outputsize);
  },
  getLatestOrderBook() { return null; },
};
