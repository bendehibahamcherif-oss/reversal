const TIMEFRAME_MAP = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '15m': { interval: '15m', range: '5d' },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '1mo' },
  '4h': { interval: '1h', range: '3mo' },
  '1d': { interval: '1d', range: '1y' },
};

const DEFAULT_TIMEFRAME = TIMEFRAME_MAP['1m'];
const YAHOO_TIMEOUT_MS = Number(process.env.YAHOO_TIMEOUT_MS || 8000);
const YAHOO_RETRIES = Math.max(0, Number(process.env.YAHOO_RETRIES || 3));
const YAHOO_MIN_INTERVAL_MS = Math.max(0, Number(process.env.YAHOO_MIN_INTERVAL_MS || 250));
const YAHOO_MAX_JITTER_MS = Math.max(0, Number(process.env.YAHOO_MAX_JITTER_MS || 175));
const YAHOO_BASE_BACKOFF_MS = Math.max(50, Number(process.env.YAHOO_BASE_BACKOFF_MS || 250));
const YAHOO_MAX_BACKOFF_MS = Math.max(YAHOO_BASE_BACKOFF_MS, Number(process.env.YAHOO_MAX_BACKOFF_MS || 2500));
const YAHOO_STALE_WINDOW_MS = Math.max(60_000, Number(process.env.YAHOO_STALE_WINDOW_MS || 86_400_000));
let nextAllowedAt = 0;
const healthState = {
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastFailureReason: null,
};

function getYahooChartUrl(symbol, { interval, range }) {
  const encoded = encodeURIComponent(String(symbol || '').toUpperCase());
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=${interval}&range=${range}`;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function jitterMs() { return Math.floor(Math.random() * (YAHOO_MAX_JITTER_MS + 1)); }
function backoffMs(attempt) { return Math.min(YAHOO_MAX_BACKOFF_MS, (YAHOO_BASE_BACKOFF_MS * (2 ** Math.max(0, attempt))) + jitterMs()); }
function logYahoo(event, details = {}) { console.info('[yahooProvider]', JSON.stringify({ event, provider: 'yahoo', ...details })); }
function recordFailure(reason) {
  healthState.consecutiveFailures += 1;
  healthState.lastFailureReason = String(reason || 'request_failed');
}
function recordSuccess() {
  healthState.lastSuccessAt = new Date().toISOString();
  healthState.consecutiveFailures = 0;
  healthState.lastFailureReason = null;
}
function isTimestampStale(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return true;
  const ageMs = Date.now() - (Number(epochSeconds) * 1000);
  return ageMs > YAHOO_STALE_WINDOW_MS;
}

function normalizeSymbolForYahoo(symbol) {
  const raw = String(symbol || '').trim();
  const upper = raw.toUpperCase();
  if (!upper) return '';
  if (upper.startsWith('^') || upper.includes('-') || upper.endsWith('=X')) return upper;
  const fxMatch = upper.match(/^([A-Z]{6})$/);
  if (fxMatch) return `${upper}=X`;
  return upper;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = YAHOO_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeYahooError(error, context = {}) {
  const message = String(error?.message || 'yahoo_request_failed');
  const aborted = error?.name === 'AbortError';
  return {
    provider: 'yahoo',
    code: aborted ? 'timeout' : 'request_failed',
    message,
    retryable: true,
    ...context,
  };
}

function validateYahooPayload(payload) {
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp || [];
  if (!result || !quote || !Array.isArray(timestamps) || !timestamps.length) return null;
  return { quote, timestamps };
}

async function fetchYahooChart(symbol, timeframe) {
  const mapping = TIMEFRAME_MAP[String(timeframe || '1m')] || DEFAULT_TIMEFRAME;
  const yahooSymbol = normalizeSymbolForYahoo(symbol);
  const url = getYahooChartUrl(yahooSymbol, mapping);
  for (let attempt = 0; attempt <= YAHOO_RETRIES; attempt += 1) {
    try {
      const waitMs = Math.max(0, nextAllowedAt - Date.now());
      if (waitMs) await sleep(waitMs);
      nextAllowedAt = Date.now() + YAHOO_MIN_INTERVAL_MS + jitterMs();
      logYahoo('request_start', { symbol: yahooSymbol, timeframe, url, attempt: attempt + 1 });
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://finance.yahoo.com/',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      logYahoo('response_received', { symbol: yahooSymbol, status: response.status, contentType, attempt: attempt + 1 });
      if (!response.ok) {
        if (response.status === 429) logYahoo('rate_limited', { symbol: yahooSymbol, status: response.status, attempt: attempt + 1 });
        if (response.status === 429 || response.status >= 500) {
          await sleep(backoffMs(attempt));
          continue;
        }
        recordFailure(`bad_status_${response.status}`);
        return { data: null, error: { provider: 'yahoo', code: 'bad_status', status: response.status, retryable: false } };
      }
      if (contentType.includes('text/html')) {
        const preview = (await response.text()).slice(0, 180);
        logYahoo('html_or_captcha_response', { symbol: yahooSymbol, preview, attempt: attempt + 1 });
        recordFailure('html_response');
        return { data: null, error: { provider: 'yahoo', code: 'html_response', retryable: true } };
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        logYahoo('parse_failed', { symbol: yahooSymbol, message: String(error?.message || 'json_parse_failed'), attempt: attempt + 1 });
        recordFailure('parse_failed');
        return { data: null, error: { provider: 'yahoo', code: 'parse_failed', retryable: true } };
      }
      const validated = validateYahooPayload(payload);
      if (!validated) {
        const emptyPayload = !payload?.chart?.result?.length;
        logYahoo(emptyPayload ? 'empty_payload' : 'invalid_payload', { symbol: yahooSymbol, attempt: attempt + 1 });
        recordFailure(emptyPayload ? 'empty_payload' : 'invalid_payload');
        return { data: null, error: { provider: 'yahoo', code: emptyPayload ? 'empty_payload' : 'invalid_payload', retryable: false } };
      }
      const latestIdx = getLatestValidIndex(validated.quote, validated.timestamps);
      if (latestIdx < 0) {
        logYahoo('stale_or_no_valid_close', { symbol: yahooSymbol, candles: validated.timestamps.length, attempt: attempt + 1 });
        recordFailure('stale_data');
        return { data: null, error: { provider: 'yahoo', code: 'stale_data', retryable: true } };
      }
      if (isTimestampStale(validated.timestamps[latestIdx])) {
        logYahoo('stale_timestamp', { symbol: yahooSymbol, latestTimestamp: validated.timestamps[latestIdx], attempt: attempt + 1 });
        recordFailure('stale_timestamp');
        return { data: null, error: { provider: 'yahoo', code: 'stale_timestamp', retryable: true } };
      }
      recordSuccess();
      return { data: validated, error: null };
    } catch (error) {
      const normalized = normalizeYahooError(error, { attempt: attempt + 1 });
      if (normalized.code === 'timeout') logYahoo('timeout', { symbol: yahooSymbol, timeoutMs: YAHOO_TIMEOUT_MS, attempt: attempt + 1 });
      else logYahoo('request_failed', { symbol: yahooSymbol, message: normalized.message, attempt: attempt + 1 });
      if (attempt >= YAHOO_RETRIES) {
        recordFailure(normalized.code || normalized.message);
        return { data: null, error: normalized };
      }
      await sleep(backoffMs(attempt));
    }
  }
  recordFailure('exhausted_retries');
  return { data: null, error: { provider: 'yahoo', code: 'exhausted_retries', retryable: true } };
}

function getLatestValidIndex(quote, timestamps) {
  for (let i = timestamps.length - 1; i >= 0; i -= 1) {
    const close = quote?.close?.[i];
    if (Number.isFinite(close)) return i;
  }
  return -1;
}

export const yahooProvider = {
  id:'yahoo',
  name:'Yahoo Finance',
  type:'fallback_delayed_unofficial',
  requiresCredentials:false,
  supportsTicks:true,
  supportsCandles:true,
  supportsOrderBook:false,
  status(){ return { status:'fallback_delayed', connected:false, warnings:['Yahoo is fallback/delayed/unofficial-style data and not institutional live feed.'], metadata: { timeoutMs: YAHOO_TIMEOUT_MS, retries: YAHOO_RETRIES, minIntervalMs: YAHOO_MIN_INTERVAL_MS } }; },
  validateCredentials(){ return { valid:true, warnings:[] }; },
  start(){ return { status:'fallback_delayed', connected:false}; },
  stop(){ return {status:'stopped',connected:false}; },
  async getLatestTick(symbol){
    const { data: chart } = await fetchYahooChart(symbol, '1m');
    if (!chart) return null;
    const idx = getLatestValidIndex(chart.quote, chart.timestamps);
    if (idx < 0) return null;
    const price = Number(chart.quote.close[idx]);
    const bid = Number.isFinite(chart.quote.low?.[idx]) ? Number(chart.quote.low[idx]) : price;
    const ask = Number.isFinite(chart.quote.high?.[idx]) ? Number(chart.quote.high[idx]) : price;
    return {
      symbol: String(symbol || '').toUpperCase(),
      price,
      bid,
      ask,
      volume: Number(chart.quote.volume?.[idx]) || 0,
      source: 'yahoo',
      timestamp: new Date(chart.timestamps[idx] * 1000).toISOString(),
      sequence: Date.now() % 1_000_000,
    };
  },
  async getLatestCandle(symbol, timeframe='1m'){
    const { data: chart } = await fetchYahooChart(symbol, timeframe);
    if (!chart) return null;
    const idx = getLatestValidIndex(chart.quote, chart.timestamps);
    if (idx < 0) return null;
    return {
      symbol: String(symbol || '').toUpperCase(),
      timeframe,
      open: Number(chart.quote.open[idx] ?? chart.quote.close[idx]),
      high: Number(chart.quote.high[idx] ?? chart.quote.close[idx]),
      low: Number(chart.quote.low[idx] ?? chart.quote.close[idx]),
      close: Number(chart.quote.close[idx]),
      volume: Number(chart.quote.volume?.[idx]) || 0,
      source: 'yahoo',
      timestamp: new Date(chart.timestamps[idx] * 1000).toISOString(),
    };
  },
  async getCandles(symbol, timeframe = '1m', limit = 200) {
    const { data: chart } = await fetchYahooChart(symbol, timeframe);
    if (!chart) return [];
    const count = Math.max(1, Number(limit) || 200);
    const items = [];
    for (let i = 0; i < chart.timestamps.length; i += 1) {
      const close = Number(chart.quote?.close?.[i]);
      if (!Number.isFinite(close)) continue;
      items.push({
        symbol: String(symbol || '').toUpperCase(),
        timeframe,
        t: Number(chart.timestamps[i]) * 1000,
        o: Number(chart.quote?.open?.[i] ?? close),
        h: Number(chart.quote?.high?.[i] ?? close),
        l: Number(chart.quote?.low?.[i] ?? close),
        c: close,
        v: Number(chart.quote?.volume?.[i]) || 0,
        source: 'yahoo',
      });
    }
    return items.slice(-count);
  },
  async debugSymbol(symbol, timeframe = '1m') {
    const normalizedSymbol = normalizeSymbolForYahoo(symbol);
    const response = await fetchYahooChart(symbol, timeframe);
    const warnings = [];
    if (!(TIMEFRAME_MAP[timeframe])) warnings.push(`timeframe ${timeframe} mapped to default ${DEFAULT_TIMEFRAME.interval}/${DEFAULT_TIMEFRAME.range}`);
    if (normalizedSymbol !== String(symbol || '').toUpperCase()) warnings.push(`symbol normalized from ${String(symbol || '').toUpperCase()} to ${normalizedSymbol}`);
    if (response.error) warnings.push(`yahoo_error:${response.error.code}`);
    return {
      provider: 'yahoo',
      symbol: normalizedSymbol,
      timeframe,
      request: { success: !response.error, failure: response.error || null },
      parsedCandleCount: response.data?.timestamps?.length || 0,
      validationWarnings: warnings,
      fallbackTriggered: Boolean(response.error),
    };
  },
  getHealth(){
    const fallbackThreshold = Math.max(1, YAHOO_RETRIES + 1);
    const healthy = healthState.consecutiveFailures < fallbackThreshold;
    return {
      provider: 'yahoo',
      healthy,
      lastSuccessAt: healthState.lastSuccessAt,
      consecutiveFailures: healthState.consecutiveFailures,
      lastFailureReason: healthState.lastFailureReason,
      fallbackActive: !healthy,
    };
  },
  getLatestOrderBook(){ return null; }
};
