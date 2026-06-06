/**
 * Alpha Vantage historical candle provider.
 * Uses TIME_SERIES_INTRADAY and TIME_SERIES_DAILY_ADJUSTED endpoints.
 */

import { normalizeCandleBatch } from '../candleSchema.js';
import { validateDateRange, getMaxLookbackDays } from '../providerCapabilities.js';
import { credentialStore } from '../../feeds/providers/credentialStore.js';

const BASE_URL = 'https://www.alphavantage.co/query';
const TIMEOUT_MS = Number(process.env.ALPHAVANTAGE_TIMEOUT_MS || 15000);

const INTRADAY_INTERVAL_MAP = {
  '1m':  '1min',
  '5m':  '5min',
  '15m': '15min',
  '30m': '30min',
  '1h':  '60min',
};

async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getApiKey(credentials) {
  if (credentials?.apiKey) return credentials.apiKey;
  try {
    const stored = credentialStore.getCredentials('alphavantage');
    return stored?.apiKey ?? credentialStore.getCredentials('alphaVantage')?.apiKey ?? null;
  } catch {
    return null;
  }
}

function parseIntradayResponse(json, interval) {
  const key = `Time Series (${interval})`;
  const series = json[key];
  if (!series || typeof series !== 'object') return [];
  return Object.entries(series).map(([datetime, bar]) => ({
    t: Date.parse(datetime),
    o: bar['1. open'],
    h: bar['2. high'],
    l: bar['3. low'],
    c: bar['4. close'],
    v: bar['5. volume'],
  }));
}

function parseDailyResponse(json, adjusted) {
  const key = adjusted ? 'Time Series (Daily)' : 'Time Series (Daily)';
  const fullKey = adjusted
    ? Object.keys(json).find((k) => k.includes('Adjusted') || k.includes('Daily'))
    : 'Time Series (Daily)';
  const series = json[fullKey ?? key];
  if (!series || typeof series !== 'object') return [];
  const closeKey = adjusted ? '5. adjusted close' : '4. close';
  return Object.entries(series).map(([date, bar]) => ({
    t: Date.parse(date),
    o: bar['1. open'],
    h: bar['2. high'],
    l: bar['3. low'],
    c: bar[closeKey] ?? bar['4. close'],
    v: bar['6. volume'] ?? bar['5. volume'],
  }));
}

/**
 * Download candles from Alpha Vantage.
 */
export async function downloadAlphaVantageHistorical({ symbol, timeframe = '1d', startMs, endMs, credentials }) {
  const apiKey = getApiKey(credentials);
  if (!apiKey) {
    return { ok: false, error: 'missing_credentials', detail: 'Alpha Vantage API key not configured.' };
  }

  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return { ok: false, error: 'invalid_symbol' };

  const now = Date.now();
  const resolvedEnd   = endMs   ? Math.min(endMs, now)   : now;
  const maxLookbackMs = getMaxLookbackDays('alphaVantage', timeframe) * 86_400_000;
  const resolvedStart = startMs ? Math.max(startMs, now - maxLookbackMs) : (resolvedEnd - 365 * 86_400_000);

  const { warnings } = validateDateRange('alphaVantage', timeframe, resolvedStart, resolvedEnd);

  const isIntraday = ['1m','5m','15m','30m','1h'].includes(timeframe);
  const isWeekly   = timeframe === '1w';

  let params;
  if (isIntraday) {
    const interval = INTRADAY_INTERVAL_MAP[timeframe];
    if (!interval) return { ok: false, error: `unsupported_timeframe:${timeframe}` };
    params = new URLSearchParams({
      function: 'TIME_SERIES_INTRADAY',
      symbol: normalized,
      interval,
      outputsize: 'full',
      apikey: apiKey,
    });
  } else if (isWeekly) {
    params = new URLSearchParams({
      function: 'TIME_SERIES_WEEKLY_ADJUSTED',
      symbol: normalized,
      apikey: apiKey,
    });
  } else {
    params = new URLSearchParams({
      function: 'TIME_SERIES_DAILY_ADJUSTED',
      symbol: normalized,
      outputsize: 'full',
      apikey: apiKey,
    });
  }

  const url = `${BASE_URL}?${params}`;
  let rawJson;
  try {
    const res = await fetchWithTimeout(url);
    rawJson = await res.json();
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, error: code, detail: err?.message, warnings };
  }

  if (rawJson?.['Error Message']) {
    return { ok: false, error: 'alphavantage_api_error', detail: rawJson['Error Message'], warnings };
  }
  if (rawJson?.['Note']) {
    warnings.push(`Alpha Vantage rate limit note: ${rawJson['Note']}`);
  }
  if (rawJson?.Information) {
    return { ok: false, error: 'rate_limited', detail: rawJson.Information, warnings };
  }

  let rawCandles;
  if (isIntraday) {
    rawCandles = parseIntradayResponse(rawJson, INTRADAY_INTERVAL_MAP[timeframe]);
  } else if (isWeekly) {
    rawCandles = parseDailyResponse(rawJson, true);
  } else {
    rawCandles = parseDailyResponse(rawJson, true);
  }

  const filtered = rawCandles.filter((c) => {
    const t = Number(c.t);
    return Number.isFinite(t) && t >= resolvedStart && t <= resolvedEnd;
  });

  const defaults = { symbol: normalized, timeframe, provider: 'alphaVantage', sourceType: 'market_data' };
  const { candles, skipped } = normalizeCandleBatch(filtered, defaults);

  return {
    ok: true,
    candles,
    skipped,
    warnings,
    provider: 'alphaVantage',
    symbol: normalized,
    timeframe,
    startDate: candles[0]    ? new Date(candles[0].timestamp).toISOString().slice(0, 10)    : null,
    endDate:   candles.at(-1) ? new Date(candles.at(-1).timestamp).toISOString().slice(0, 10) : null,
  };
}

export const alphaVantageHistoricalProvider = {
  id: 'alphaVantage',
  name: 'Alpha Vantage',
  requiresCredentials: true,
  download: (opts) => downloadAlphaVantageHistorical(opts),
};
