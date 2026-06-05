/**
 * Provider capability matrix for historical data downloads.
 * Describes what each provider can actually deliver: date range limits,
 * supported timeframes, asset classes, rate limits, and credential requirements.
 */

export const PROVIDER_CAPABILITIES = {
  yahoo: {
    id: 'yahoo',
    name: 'Yahoo Finance',
    requiresCredentials: false,
    sourceType: 'delayed_rest',
    assetClasses: ['equity', 'etf', 'index', 'fx', 'crypto'],
    timeframes: ['1m','5m','15m','30m','1h','1d','1w'],
    maxLookbackByTimeframe: {
      '1m':  7,
      '5m':  60,
      '15m': 60,
      '30m': 60,
      '1h':  730,
      '1d':  7300,
      '1w':  7300,
    },
    rateLimit: { requestsPerMinute: 20, minIntervalMs: 500 },
    maxCandlesPerRequest: 1500,
    adjustedPrices: false,
    notes: 'Unofficial delayed REST API. No guarantee of stability. Use for dev/research only.',
  },
  twelvedata: {
    id: 'twelvedata',
    name: 'Twelve Data',
    requiresCredentials: true,
    credentialFields: ['apiKey'],
    sourceType: 'market_data',
    assetClasses: ['equity', 'etf', 'index', 'fx', 'crypto', 'futures'],
    timeframes: ['1m','5m','15m','30m','1h','4h','1d','1w'],
    maxLookbackByTimeframe: {
      '1m':  365,
      '5m':  365,
      '15m': 730,
      '30m': 730,
      '1h':  3650,
      '4h':  3650,
      '1d':  36500,
      '1w':  36500,
    },
    rateLimit: { requestsPerMinute: 8, minIntervalMs: 8000 },
    maxCandlesPerRequest: 5000,
    adjustedPrices: true,
    notes: 'Requires API key. Free tier: 8 req/min, 800 req/day.',
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon.io',
    requiresCredentials: true,
    credentialFields: ['apiKey'],
    sourceType: 'market_data',
    assetClasses: ['equity', 'etf', 'index', 'options', 'forex', 'crypto'],
    timeframes: ['1m','5m','15m','30m','1h','4h','1d','1w'],
    maxLookbackByTimeframe: {
      '1m':  730,
      '5m':  730,
      '15m': 1825,
      '30m': 1825,
      '1h':  36500,
      '4h':  36500,
      '1d':  36500,
      '1w':  36500,
    },
    rateLimit: { requestsPerMinute: 5, minIntervalMs: 12000 },
    maxCandlesPerRequest: 50000,
    adjustedPrices: true,
    notes: 'Requires API key. Free tier: 5 req/min. Excellent history depth.',
  },
  alphaVantage: {
    id: 'alphaVantage',
    name: 'Alpha Vantage',
    requiresCredentials: true,
    credentialFields: ['apiKey'],
    sourceType: 'market_data',
    assetClasses: ['equity', 'etf', 'forex', 'crypto'],
    timeframes: ['1m','5m','15m','30m','1h','1d','1w'],
    maxLookbackByTimeframe: {
      '1m':  30,
      '5m':  30,
      '15m': 30,
      '30m': 30,
      '1h':  30,
      '1d':  36500,
      '1w':  36500,
    },
    rateLimit: { requestsPerMinute: 5, minIntervalMs: 12000 },
    maxCandlesPerRequest: 1000,
    adjustedPrices: true,
    notes: 'Requires API key. Free tier: 25 req/day. Intraday limited to 30 days.',
  },
};

/**
 * Get capabilities for a specific provider.
 */
export function getCapabilities(providerId) {
  return PROVIDER_CAPABILITIES[providerId] ?? null;
}

/**
 * Get all providers capable of delivering data for a given timeframe.
 */
export function getCapableProviders(timeframe) {
  return Object.values(PROVIDER_CAPABILITIES).filter(
    (cap) => cap.timeframes.includes(timeframe)
  );
}

/**
 * Get max lookback days for a provider+timeframe combination.
 */
export function getMaxLookbackDays(providerId, timeframe) {
  const cap = PROVIDER_CAPABILITIES[providerId];
  if (!cap) return 0;
  return cap.maxLookbackByTimeframe[timeframe] ?? 365;
}

/**
 * Validate a date range against provider capabilities.
 * Returns { ok, warnings }.
 */
export function validateDateRange(providerId, timeframe, startMs, endMs) {
  const cap = PROVIDER_CAPABILITIES[providerId];
  if (!cap) return { ok: false, warnings: [`Unknown provider: ${providerId}`] };

  const warnings = [];
  const maxDays = getMaxLookbackDays(providerId, timeframe);
  const requestedDays = (endMs - startMs) / 86_400_000;
  const earliestAllowedMs = Date.now() - maxDays * 86_400_000;

  if (!cap.timeframes.includes(timeframe)) {
    return { ok: false, warnings: [`Provider ${providerId} does not support timeframe ${timeframe}`] };
  }

  if (startMs < earliestAllowedMs) {
    warnings.push(
      `Requested start date exceeds ${cap.name}'s ${maxDays}-day lookback for ${timeframe}. ` +
      `Data before ${new Date(earliestAllowedMs).toISOString().slice(0, 10)} may be unavailable.`
    );
  }

  if (requestedDays > maxDays) {
    warnings.push(
      `Requested range (${Math.round(requestedDays)} days) exceeds max lookback (${maxDays} days) for ${timeframe}.`
    );
  }

  return { ok: true, warnings };
}
