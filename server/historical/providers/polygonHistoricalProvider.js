/**
 * Polygon.io historical candle provider.
 * Uses /v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{from}/{to}
 */

import { normalizeCandleBatch } from '../candleSchema.js';
import { validateDateRange, getMaxLookbackDays } from '../providerCapabilities.js';
import { credentialStore } from '../../feeds/providers/credentialStore.js';

const BASE_URL = 'https://api.polygon.io';
const TIMEOUT_MS = Number(process.env.POLYGON_TIMEOUT_MS || 20000);

const TIMEFRAME_SPAN_MAP = {
  '1m':  { multiplier: 1,  timespan: 'minute' },
  '5m':  { multiplier: 5,  timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '30m': { multiplier: 30, timespan: 'minute' },
  '1h':  { multiplier: 1,  timespan: 'hour' },
  '4h':  { multiplier: 4,  timespan: 'hour' },
  '1d':  { multiplier: 1,  timespan: 'day' },
  '1w':  { multiplier: 1,  timespan: 'week' },
};

function formatDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
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
    const stored = credentialStore.getCredentials('polygon');
    return stored?.apiKey ?? null;
  } catch {
    return null;
  }
}

/**
 * Download all pages of Polygon aggregates results within the date range.
 * Handles cursor-based pagination automatically.
 */
async function fetchAllPages(baseUrl, apiKey, maxPages = 50) {
  const all = [];
  let url = baseUrl;
  let page = 0;

  while (url && page < maxPages) {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Object.assign(new Error(`polygon_http_${res.status}`), { detail: body.slice(0, 200) });
    }
    const json = await res.json();
    if (json.status === 'ERROR') throw new Error(json.error || 'polygon_api_error');
    const results = Array.isArray(json.results) ? json.results : [];
    all.push(...results);
    const nextUrl = json.next_url;
    url = nextUrl ? `${nextUrl}&apiKey=${encodeURIComponent(apiKey)}` : null;
    page += 1;
  }
  return all;
}

/**
 * Download candles from Polygon.io.
 */
export async function downloadPolygonHistorical({ symbol, timeframe = '1d', startMs, endMs, limit, credentials }) {
  const apiKey = getApiKey(credentials);
  if (!apiKey) {
    return { ok: false, error: 'missing_credentials', detail: 'Polygon.io API key not configured.' };
  }

  const normalized = String(symbol || '').trim().toUpperCase();
  if (!normalized) return { ok: false, error: 'invalid_symbol' };

  const span = TIMEFRAME_SPAN_MAP[timeframe];
  if (!span) return { ok: false, error: `unsupported_timeframe:${timeframe}` };

  const now = Date.now();
  const resolvedEnd   = endMs   ? Math.min(endMs, now)   : now;
  const maxLookbackMs = getMaxLookbackDays('polygon', timeframe) * 86_400_000;
  const resolvedStart = startMs ? Math.max(startMs, now - maxLookbackMs) : (resolvedEnd - 365 * 86_400_000);

  const { warnings } = validateDateRange('polygon', timeframe, resolvedStart, resolvedEnd);

  const params = new URLSearchParams({
    adjusted: 'true',
    sort: 'asc',
    limit: String(Math.min(50000, limit || 50000)),
    apiKey,
  });

  const from = formatDate(resolvedStart);
  const to   = formatDate(resolvedEnd);
  const url  = `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(normalized)}/range/${span.multiplier}/${span.timespan}/${from}/${to}?${params}`;

  let rawResults;
  try {
    rawResults = await fetchAllPages(url, apiKey);
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network_error');
    return { ok: false, error: code, detail: err?.detail, warnings };
  }

  const rawCandles = rawResults.map((bar) => ({
    t: Number(bar.t),
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v,
  }));

  const defaults = { symbol: normalized, timeframe, provider: 'polygon', sourceType: 'market_data' };
  const { candles, skipped } = normalizeCandleBatch(rawCandles, defaults);

  return {
    ok: true,
    candles,
    skipped,
    warnings,
    provider: 'polygon',
    symbol: normalized,
    timeframe,
    startDate: candles[0]    ? new Date(candles[0].timestamp).toISOString().slice(0, 10)    : null,
    endDate:   candles.at(-1) ? new Date(candles.at(-1).timestamp).toISOString().slice(0, 10) : null,
  };
}

export const polygonHistoricalProvider = {
  id: 'polygon',
  name: 'Polygon.io',
  requiresCredentials: true,
  download: (opts) => downloadPolygonHistorical(opts),
};
