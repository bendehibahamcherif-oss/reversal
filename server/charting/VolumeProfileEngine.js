const VALUE_AREA_PCT = 0.70;
const DEFAULT_BINS = 24;

function parseTimestamp(val) {
  if (val == null) return null;
  const n = Number(val);
  if (!isNaN(n) && n > 0) return n;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function filterCandles(candles, { mode, start, end }) {
  if (!candles.length) return candles;

  const now = Date.now();

  switch (mode) {
    case 'fixed_range': {
      const s = parseTimestamp(start) ?? 0;
      const e = parseTimestamp(end) ?? now;
      return candles.filter((c) => c.time >= s && c.time <= e);
    }

    case 'daily': {
      const todayUTC = new Date(now);
      todayUTC.setUTCHours(0, 0, 0, 0);
      const dayStart = todayUTC.getTime();
      const dayEnd = dayStart + 86_400_000;
      return candles.filter((c) => c.time >= dayStart && c.time < dayEnd);
    }

    case 'session': {
      // NYSE regular session 09:30–16:00 ET (UTC-5, conservative non-DST offset)
      const ET_OFFSET_MS = -5 * 3_600_000;
      const todayET = new Date(now + ET_OFFSET_MS);
      todayET.setUTCHours(0, 0, 0, 0);
      const todayETMs = todayET.getTime();
      const SESSION_START = 9.5 * 3_600_000;  // 09:30
      const SESSION_END   = 16  * 3_600_000;  // 16:00
      return candles.filter((c) => {
        const etMs = c.time + ET_OFFSET_MS;
        const dayMs = etMs - (etMs % 86_400_000);
        if (dayMs !== todayETMs) return false;
        const msSinceMidnight = etMs - dayMs;
        return msSinceMidnight >= SESSION_START && msSinceMidnight < SESSION_END;
      });
    }

    case 'visible_range':
    default:
      return candles;
  }
}

function buildBins(candles, binCount) {
  let priceMin = Infinity;
  let priceMax = -Infinity;
  for (const c of candles) {
    if (c.low  < priceMin) priceMin = c.low;
    if (c.high > priceMax) priceMax = c.high;
  }

  // Guard against degenerate / zero-range candles
  if (!isFinite(priceMin) || !isFinite(priceMax) || priceMin >= priceMax) {
    const mid = isFinite(priceMin) ? priceMin : 0;
    priceMin = mid * 0.999 || -0.001;
    priceMax = mid * 1.001 ||  0.001;
  }

  const binSize = (priceMax - priceMin) / binCount;
  const bins = Array.from({ length: binCount }, (_, i) => ({
    lo:     priceMin + i       * binSize,
    hi:     priceMin + (i + 1) * binSize,
    mid:    priceMin + (i + 0.5) * binSize,
    volume: 0,
  }));

  for (const c of candles) {
    const vol = c.volume || 0;
    if (vol === 0) continue;

    const candleRange = c.high - c.low;
    if (candleRange <= 0) {
      // Doji: assign all volume to the bin that contains close
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((c.close - priceMin) / binSize)));
      bins[idx].volume += vol;
    } else {
      // Proportional distribution across overlapping bins
      for (let i = 0; i < binCount; i++) {
        const overlap = Math.min(c.high, bins[i].hi) - Math.max(c.low, bins[i].lo);
        if (overlap > 0) bins[i].volume += vol * (overlap / candleRange);
      }
    }
  }

  return bins;
}

// Expand outward from POC until VALUE_AREA_PCT of total volume is captured.
function computeValueArea(bins, pocIdx, totalVolume) {
  const target = totalVolume * VALUE_AREA_PCT;
  let accumulated = bins[pocIdx].volume;
  let lo = pocIdx;
  let hi = pocIdx;

  while (accumulated < target && (lo > 0 || hi < bins.length - 1)) {
    const loVol = lo > 0               ? bins[lo - 1].volume : -Infinity;
    const hiVol = hi < bins.length - 1 ? bins[hi + 1].volume : -Infinity;
    if (loVol >= hiVol) {
      lo--;
      accumulated += bins[lo].volume;
    } else {
      hi++;
      accumulated += bins[hi].volume;
    }
  }

  return { loIdx: lo, hiIdx: hi };
}

export class VolumeProfileEngine {
  /**
   * Compute a volume profile over a set of OHLCV candles.
   *
   * @param {Array<{time,open,high,low,close,volume}>} candles
   * @param {{ mode?, bins?, start?, end? }} options
   * @returns {{ profile, poc, vah, val, hvn, lvn, totalVolume }}
   */
  static compute(candles, { mode = 'visible_range', bins: binCount = DEFAULT_BINS, start, end } = {}) {
    const safeBins  = Math.min(200, Math.max(5, Math.floor(Number(binCount) || DEFAULT_BINS)));
    const filtered  = filterCandles(Array.isArray(candles) ? candles : [], { mode, start, end });

    if (!filtered.length) {
      return { profile: [], poc: null, vah: null, val: null, hvn: [], lvn: [], totalVolume: 0 };
    }

    const bins        = buildBins(filtered, safeBins);
    const totalVolume = bins.reduce((s, b) => s + b.volume, 0);

    if (totalVolume === 0) {
      const mid = Math.floor(bins.length / 2);
      return {
        profile:     bins.map((b) => ({ price: b.mid, volume: 0, isHVN: false, isLVN: false })),
        poc:         { price: bins[mid].mid, volume: 0 },
        vah:         bins[bins.length - 1].hi,
        val:         bins[0].lo,
        hvn:         [],
        lvn:         [],
        totalVolume: 0,
      };
    }

    // Point of Control
    let pocIdx = 0;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i].volume > bins[pocIdx].volume) pocIdx = i;
    }

    // Value Area
    const { loIdx, hiIdx } = computeValueArea(bins, pocIdx, totalVolume);

    // HVN / LVN thresholds
    const mean     = totalVolume / bins.length;
    const variance = bins.reduce((acc, b) => acc + (b.volume - mean) ** 2, 0) / bins.length;
    const stddev   = Math.sqrt(variance);
    const hvnThreshold = mean + stddev;
    const lvnThreshold = mean - 0.5 * stddev;

    const profile = bins.map((b) => ({
      price:  b.mid,
      volume: b.volume,
      isHVN:  b.volume > hvnThreshold,
      isLVN:  b.volume > 0 && b.volume < lvnThreshold,
    }));

    return {
      profile,
      poc:         { price: bins[pocIdx].mid, volume: bins[pocIdx].volume },
      vah:         bins[hiIdx].hi,
      val:         bins[loIdx].lo,
      hvn:         profile.filter((b) => b.isHVN),
      lvn:         profile.filter((b) => b.isLVN),
      totalVolume,
    };
  }
}
