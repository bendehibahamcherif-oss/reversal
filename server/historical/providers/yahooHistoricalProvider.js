/**
 * Yahoo Finance historical data provider.
 * Uses the v8 chart API with period1/period2 Unix timestamps for date range downloads.
 */

import { normalizeCandleBatch } from '../candleSchema.js';
import { validateDateRange, getMaxLookbackDays } from '../providerCapabilities.js';

const YAHOO_TIMEOUT_MS = Number(process.env.YAHOO_TIMEOUT_MS || 15000);

const TIMEFRAME_INTERVAL_MAP = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '60m',
  '4h':  '1h',
  '1d':  '1d',
  '1w':  '1wk',
};

function normalizeSymbol(symbol) {
  const upper = String(symbol || '').trim().toUpperCase();
  if (!upper) return '';
  if (upper.startsWith('^') || upper.includes('-') || upper.endsWith('=X')) return upper;
  const fxMatch = upper.match(/^([A-Z]{6})$/);
  if (fxMatch) return `${upper}=X`;
  return upper;
}

async function fetchWithTimeout(url, timeoutMs = YAHOO_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; reversal-historical/1.0)',
        'Accept': 'application/json',
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download candles for symbol between startMs and endMs (Unix ms).
 * Returns { ok, candles, skipped, warnings, provider, symbol, timeframe, startDate, endDate }.
 */
export async function downloadYahooHistorical({ symbol, timeframe = '1d', startMs, endMs, limit }) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { ok: false, error: 'invalid_symbol' };

  const interval = TIMEFRAME_INTERVAL_MAP[timeframe];
  if (!interval) return { ok: false, error: `unsupported_timeframe:${timeframe}` };

  const now = Date.now();
  const resolvedEnd = endMs ? Math.min(endMs, now) : now;
  const maxLookback = getMaxLookbackDays('yahoo', timeframe) * 86_400_000;
  const resolvedStart = startMs ? Math.max(startMs, now - maxLookback) : (resolvedEnd - 365 * 86_400_000);

  const { warnings } = validateDateRange('yahoo', timeframe, resolvedStart, resolvedEnd);

  const period1 = Math.floor(resolvedStart / 1000);
  const period2 = Math.floor(resolvedEnd / 1000);
  const encoded = encodeURIComponent(normalized);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=${interval}&period1=${period1}&period2=${period2}&events=history`;

  let rawJson;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `yahoo_http_${res.status}`, detail: body.slice(0, 200), warnings };
    }
    rawJson = await res.json();
  } catch (err) {
    const code = err?.name === 'AbortError' ? 'timeout' : 'network_error';
    return { ok: false, error: code, detail: err?.message, warnings };
  }

  const result = rawJson?.chart?.result?.[0];
  if (!result) {
    const yErr = rawJson?.chart?.error;
    return { ok: false, error: 'no_data', detail: yErr?.description ?? 'yahoo returned no chart result', warnings };
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const rawCandles = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = Number(quote.close?.[i]);
    if (!Number.isFinite(close)) continue;
    rawCandles.push({
      t: Number(timestamps[i]) * 1000,
      o: quote.open?.[i],
      h: quote.high?.[i],
      l: quote.low?.[i],
      c: close,
      v: quote.volume?.[i],
    });
  }

  const defaults = { symbol: normalized, timeframe, provider: 'yahoo', sourceType: 'delayed_rest' };
  const { candles, skipped } = normalizeCandleBatch(rawCandles, defaults);

  const trimmed = limit ? candles.slice(-Number(limit)) : candles;

  return {
    ok: true,
    candles: trimmed,
    skipped,
    warnings,
    provider: 'yahoo',
    symbol: normalized,
    timeframe,
    startDate: trimmed[0]  ? new Date(trimmed[0].timestamp).toISOString().slice(0, 10)  : null,
    endDate:   trimmed.at(-1) ? new Date(trimmed.at(-1).timestamp).toISOString().slice(0, 10) : null,
  };
}

export const yahooHistoricalProvider = {
  id: 'yahoo',
  name: 'Yahoo Finance',
  requiresCredentials: false,
  download: (opts) => downloadYahooHistorical(opts),
};
