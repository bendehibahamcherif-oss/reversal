/**
 * Twelve Data historical candle provider.
 * Uses time_series endpoint with start_date/end_date parameters.
 */

import { normalizeCandleBatch } from '../candleSchema.js';
import { validateDateRange, getMaxLookbackDays } from '../providerCapabilities.js';
import { credentialStore } from '../../feeds/providers/credentialStore.js';

const BASE_URL = 'https://api.twelvedata.com';
const TIMEOUT_MS = Number(process.env.TWELVEDATA_TIMEOUT_MS || 15000);

const TIMEFRAME_INTERVAL_MAP = {
  '1m':  '1min',
  '5m':  '5min',
  '15m': '15min',
  '30m': '30min',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1day',
  '1w':  '1week',
};

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase() || null;
}

function formatDate(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

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
    const stored = credentialStore.getCredentials('twelvedata');
    return stored?.apiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Download candles from Twelve Data.
 */
export async function downloadTwelveDataHistorical({ symbol, timeframe = '1d', startMs, endMs, limit, credentials }) {
  const apiKey = getApiKey(credentials);
  if (!apiKey) {
    return { ok: false, error: 'missing_credentials', detail: 'Twelve Data API key not configured.' };
  }

  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { ok: false, error: 'invalid_symbol' };

  const interval = TIMEFRAME_INTERVAL_MAP[timeframe];
  if (!interval) return { ok: false, error: `unsupported_timeframe:${timeframe}` };

  const now = Date.now();
  const resolvedEnd   = endMs   ? Math.min(endMs, now)   : now;
  const maxLookbackMs = getMaxLookbackDays('twelvedata', timeframe) * 86_400_000;
  const resolvedStart = startMs ? Math.max(startMs, now - maxLookbackMs) : (resolvedEnd - 365 * 86_400_000);

  const { warnings } = validateDateRange('twelvedata', timeframe, resolvedStart, resolvedEnd);

  const outputsize = limit ? Math.min(5000, Number(limit)) : 5000;
  const params = new URLSearchParams({
    symbol:     normalized,
    interval,
    start_date: formatDate(resolvedStart),
    end_date:   formatDate(resolvedEnd),
    outputsize: String(outputsize),
    apikey:     apiKey,
  });

  const url = `${BASE_URL}/time_series?${params}`;
  let rawJson;
  try {
    const res = await fetchWithTimeout(url);
    rawJson = await res.json();
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, error: code, detail: err?.message, warnings };
  }

  if (rawJson?.status === 'error') {
    return { ok: false, error: 'twelvedata_api_error', detail: rawJson?.message, warnings };
  }

  const values = Array.isArray(rawJson?.values) ? rawJson.values : [];
  const defaults = { symbol: normalized, timeframe, provider: 'twelvedata', sourceType: 'market_data' };
  const { candles, skipped } = normalizeCandleBatch(values, defaults);

  return {
    ok: true,
    candles,
    skipped,
    warnings,
    provider: 'twelvedata',
    symbol: normalized,
    timeframe,
    startDate: candles[0]    ? new Date(candles[0].timestamp).toISOString().slice(0, 10)    : null,
    endDate:   candles.at(-1) ? new Date(candles.at(-1).timestamp).toISOString().slice(0, 10) : null,
  };
}

export const twelveDataHistoricalProvider = {
  id: 'twelvedata',
  name: 'Twelve Data',
  requiresCredentials: true,
  download: (opts) => downloadTwelveDataHistorical(opts),
};
