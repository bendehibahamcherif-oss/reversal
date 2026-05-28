// ── helpers ──────────────────────────────────────────────────────────────────

function parseTimestamp(val) {
  if (val == null) return null;
  const n = Number(val);
  if (!isNaN(n) && n > 0) return n;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// NYSE regular session start/end relative to midnight ET (in ms)
const SESSION_START_MS = 9.5 * 3_600_000;   // 09:30
const SESSION_END_MS   = 16  * 3_600_000;   // 16:00
// Conservative non-DST offset; covers EST (UTC-5). EDT (UTC-4) hours still fall in range.
const ET_OFFSET_MS = -5 * 3_600_000;

/**
 * Find the most-recent NYSE session day (midnight ET, in UTC ms).
 * Walks backwards up to 7 days to skip weekends / holidays.
 */
function mostRecentSessionDay() {
  for (let daysBack = 0; daysBack < 7; daysBack++) {
    const probe = Date.now() - daysBack * 86_400_000;
    const probeET = new Date(probe + ET_OFFSET_MS);
    const dow = probeET.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      probeET.setUTCHours(0, 0, 0, 0);
      return probeET.getTime() - ET_OFFSET_MS; // convert back to UTC
    }
  }
  return null;
}

// ── exports ───────────────────────────────────────────────────────────────────

/**
 * Filter an OHLCV candle array to the relevant time window for a given mode.
 * Falls back to all candles if the filter produces zero results.
 */
export function filterCandlesByMode(candles, mode) {
  const before = candles.length;
  let filtered;

  switch (mode) {
    case 'daily': {
      const now = new Date();
      now.setUTCHours(0, 0, 0, 0);
      const dayStart = now.getTime();
      const dayEnd   = dayStart + 86_400_000;
      filtered = candles.filter((c) => c.time >= dayStart && c.time < dayEnd);
      break;
    }

    case 'session': {
      const sessionDayUTC = mostRecentSessionDay();
      if (sessionDayUTC == null) {
        filtered = [];
        break;
      }
      const sessionStartUTC = sessionDayUTC + SESSION_START_MS + (-ET_OFFSET_MS);
      const sessionEndUTC   = sessionDayUTC + SESSION_END_MS   + (-ET_OFFSET_MS);
      filtered = candles.filter((c) => c.time >= sessionStartUTC && c.time < sessionEndUTC);
      break;
    }

    case 'visible_range':
    case 'fixed_range':
    default:
      filtered = candles;
      break;
  }

  // Fallback: if filter produced nothing, use all candles
  if (filtered.length === 0 && candles.length > 0) {
    filtered = candles;
  }

  console.log('[VolumeProfileEngine]', mode, 'filter', { before, after: filtered.length });
  return filtered;
}

/**
 * Build a volume profile histogram over an OHLCV candle set.
 *
 * @param {Array<{time,open,high,low,close,volume}>} candles
 * @param {number} [bins=50]
 * @returns {{ profile, poc, vah, val, hvn, lvn }}
 */
export function buildVolumeProfile(candles, bins = 50) {
  const binCount = Math.min(200, Math.max(5, Math.floor(Number(bins) || 50)));

  if (!Array.isArray(candles) || candles.length === 0) {
    return { profile: [], poc: null, vah: null, val: null, hvn: [], lvn: [] };
  }

  // Price range
  let minPrice = Infinity;
  let maxPrice = -Infinity;
  for (const c of candles) {
    if (c.low  < minPrice) minPrice = c.low;
    if (c.high > maxPrice) maxPrice = c.high;
  }

  if (!isFinite(minPrice) || !isFinite(maxPrice) || maxPrice - minPrice < 1e-10) {
    return { profile: [], poc: null, vah: null, val: null, hvn: [], lvn: [] };
  }

  const binSize     = (maxPrice - minPrice) / binCount;
  const volumeByBin = new Float64Array(binCount);

  for (const c of candles) {
    const vol = c.volume || 0;
    if (vol === 0) continue;

    const candleRange = c.high - c.low;
    if (candleRange < 1e-10) {
      // Degenerate candle: all volume in the bin that contains the price
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - minPrice) / binSize)));
      volumeByBin[idx] += vol;
    } else {
      for (let i = 0; i < binCount; i++) {
        const binLo  = minPrice + i       * binSize;
        const binHi  = minPrice + (i + 1) * binSize;
        const overlap = Math.min(c.high, binHi) - Math.max(c.low, binLo);
        if (overlap > 0) volumeByBin[i] += vol * (overlap / candleRange);
      }
    }
  }

  // Build profile array
  const profile = Array.from({ length: binCount }, (_, i) => {
    const binLow  = minPrice + i       * binSize;
    const binHigh = minPrice + (i + 1) * binSize;
    const price   = binLow + binSize * 0.5;
    return {
      price,
      priceLevel: price,
      binLow,
      binHigh,
      volume: Math.round(volumeByBin[i]),
    };
  });

  // POC
  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) {
    if (volumeByBin[i] > volumeByBin[pocIdx]) pocIdx = i;
  }
  const poc = profile[pocIdx].price;

  // Value Area (70% expanding outward from POC)
  const totalVolume = profile.reduce((s, b) => s + b.volume, 0);
  const TARGET      = totalVolume * 0.70;
  let vaVolume = profile[pocIdx].volume;
  let loIdx    = pocIdx;
  let hiIdx    = pocIdx;

  while (vaVolume < TARGET && (loIdx > 0 || hiIdx < binCount - 1)) {
    const upVol   = hiIdx < binCount - 1 ? volumeByBin[hiIdx + 1] : -Infinity;
    const downVol = loIdx > 0            ? volumeByBin[loIdx - 1] : -Infinity;
    if (upVol >= downVol) {
      hiIdx++;
      vaVolume += volumeByBin[hiIdx];
    } else {
      loIdx--;
      vaVolume += volumeByBin[loIdx];
    }
  }

  const vah = profile[hiIdx].price;
  const val = profile[loIdx].price;

  // HVN / LVN via percentile
  const sortedVols = profile.map((b) => b.volume).slice().sort((a, b) => a - b);
  const p70  = sortedVols[Math.floor(sortedVols.length * 0.70)];
  const p30  = sortedVols[Math.floor(sortedVols.length * 0.30)];

  const hvn = profile.filter((b) => b.volume > p70).map((b) => b.price);
  const lvn = profile.filter((b) => b.volume > 0 && b.volume < p30).map((b) => b.price);

  return { profile, poc, vah, val, hvn, lvn };
}
