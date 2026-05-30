// ── Multi-Asset Analytics Engine ───────────────────────────────────────────────
//
// Computations (all on log returns for numerical stability):
//   correlationMatrix  — Pearson NxN matrix over a rolling window
//   betaMetrics        — rolling beta + correlation vs a chosen benchmark
//   sectorRotation     — risk-adjusted momentum ranking for sector ETFs
//   volatilityHeatmap  — annualized rolling vol per symbol
//   relativePerformance — cumulative return rebased to 100 vs benchmark
//
// DATA ACCESS
//   feedManager.getReplayCandles() — active provider chain (Yahoo → fallback_demo)
//   Raw candle fields: { c|close, o|open, h|high, l|low, v|volume, t|time }
//
// NUMERICAL SAFETY
//   • Log returns guard against non-positive closes (replace with 0)
//   • Correlation/beta guard against flat series (std < 1e-12) → returns null
//   • All output numbers rounded to 4 decimal places

import { feedManager } from '../feeds/feedManager.js';

// ── Annualization factors (trading periods per year) ─────────────────────────

const ANN_FACTOR = {
  '1m':  252 * 390,
  '5m':  252 * 78,
  '15m': 252 * 26,
  '30m': 252 * 13,
  '1h':  252 * 6.5,
  '4h':  252 * 1.625,
  '1d':  252,
  '1w':  52,
};

// ── Canonical sector ETF proxies ─────────────────────────────────────────────

const SECTOR_ETFS = {
  Technology:               'XLK',
  Healthcare:               'XLV',
  Financials:               'XLF',
  Energy:                   'XLE',
  Materials:                'XLB',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples':       'XLP',
  Utilities:                'XLU',
  'Real Estate':            'XLRE',
  Industrials:              'XLI',
  'Communication Services': 'XLC',
};

// ── Math helpers ──────────────────────────────────────────────────────────────

// Compute log returns; skips pairs where either close is non-positive
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a > 0 && b > 0) {
      const r = Math.log(b / a);
      out.push(isFinite(r) ? r : 0);
    } else {
      out.push(0);
    }
  }
  return out;
}

function _mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _variance(arr) {
  if (arr.length < 2) return 0;
  const m = _mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
}

function _std(arr) {
  return Math.sqrt(_variance(arr));
}

function _cov(arrA, arrB) {
  const n = Math.min(arrA.length, arrB.length);
  if (n < 2) return 0;
  const mA = _mean(arrA.slice(0, n));
  const mB = _mean(arrB.slice(0, n));
  let cov = 0;
  for (let i = 0; i < n; i++) cov += (arrA[i] - mA) * (arrB[i] - mB);
  return cov / n;
}

// Pearson correlation; returns null when either series is flat (std < 1e-12)
function pearson(a, b) {
  const n  = Math.min(a.length, b.length);
  const sA = _std(a.slice(0, n));
  const sB = _std(b.slice(0, n));
  if (sA < 1e-12 || sB < 1e-12) return null;
  return Math.max(-1, Math.min(1, _cov(a.slice(0, n), b.slice(0, n)) / (sA * sB)));
}

// Beta of asset vs benchmark = cov / var(benchmark); null when benchmark is flat
function _beta(assetRet, bmRet) {
  const n     = Math.min(assetRet.length, bmRet.length);
  const vBm   = _variance(bmRet.slice(0, n));
  if (vBm < 1e-20) return null;
  return _cov(assetRet.slice(0, n), bmRet.slice(0, n)) / vBm;
}

// Annualized volatility (as decimal, e.g. 0.18 = 18%)
function annualizedVol(returns, timeframe) {
  const factor = ANN_FACTOR[timeframe] ?? 252;
  return _std(returns) * Math.sqrt(factor);
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function _fetchCloses(symbol, timeframe, limit) {
  try {
    const data    = await feedManager.getReplayCandles(symbol, timeframe, limit);
    const candles = Array.isArray(data?.candles) ? data.candles : [];
    const closes  = candles
      .map((c) => Number(c.c ?? c.close))
      .filter((v) => isFinite(v) && v > 0);
    return { closes, source: data?.source || 'fallback_demo' };
  } catch {
    return { closes: [], source: 'error' };
  }
}

// Parallel fetch for multiple symbols; returns Map<symbol, { closes, source }>
async function _fetchMulti(symbols, timeframe, limit) {
  const pairs = await Promise.all(
    symbols.map(async (sym) => [sym, await _fetchCloses(sym, timeframe, limit)]),
  );
  return new Map(pairs);
}

function _r4(n) { return n != null && isFinite(n) ? Number(n.toFixed(4)) : null; }

// Determine primary source label across fetched data map
function _primarySource(dataMap) {
  for (const { source } of dataMap.values()) {
    if (source !== 'fallback_demo' && source !== 'error') return source;
  }
  return 'fallback_demo';
}

// ── Engine ────────────────────────────────────────────────────────────────────

export const multiAssetEngine = {

  SECTOR_ETFS,

  // ── Correlation matrix ────────────────────────────────────────────────────
  //
  // Returns NxN Pearson correlation computed on log returns over the most-
  // recent `window` periods. Values on the diagonal are always 1.0; off-
  // diagonal null means insufficient or flat data.

  async correlationMatrix({ symbols, timeframe = '1d', window: win = 20 } = {}) {
    const syms = (Array.isArray(symbols) && symbols.length)
      ? symbols.map((s) => String(s).toUpperCase())
      : ['SPY', 'QQQ', 'IWM', 'GLD', 'TLT'];
    const W     = Math.max(2, Number(win) || 20);
    const limit = Math.min(500, W + 60);

    const data       = await _fetchMulti(syms, timeframe, limit);
    const returnsMap = new Map();
    for (const [sym, { closes }] of data) {
      returnsMap.set(sym, logReturns(closes).slice(-W));
    }

    const matrix = {};
    for (const symA of syms) {
      matrix[symA] = {};
      for (const symB of syms) {
        if (symA === symB) {
          matrix[symA][symB] = 1.0;
        } else {
          const rA = returnsMap.get(symA) || [];
          const rB = returnsMap.get(symB) || [];
          const n  = Math.min(rA.length, rB.length);
          matrix[symA][symB] = n < 2 ? null : _r4(pearson(rA.slice(-n), rB.slice(-n)));
        }
      }
    }

    return { ok: true, matrix, symbols: syms, window: W, timeframe, source: _primarySource(data) };
  },

  // ── Rolling beta ──────────────────────────────────────────────────────────
  //
  // For each symbol in `symbols`, computes beta vs `benchmark` using a rolling
  // window. Returns the latest beta, latest correlation, and rolling beta series.
  // Beta > 1: more volatile than benchmark; < 0: inverse; null: flat data.

  async betaMetrics({ symbols, benchmark = 'SPY', timeframe = '1d', window: win = 20 } = {}) {
    const bm   = String(benchmark).toUpperCase();
    const syms = (Array.isArray(symbols) && symbols.length)
      ? symbols.map((s) => String(s).toUpperCase()).filter((s) => s !== bm)
      : ['QQQ', 'IWM', 'GLD', 'TLT'];
    const W     = Math.max(2, Number(win) || 20);
    const limit = Math.min(500, W + 100);

    const data      = await _fetchMulti([bm, ...syms], timeframe, limit);
    const bmReturns = logReturns((data.get(bm) || {}).closes || []);

    const betaResults = {};
    for (const sym of syms) {
      const assetCloses  = (data.get(sym) || {}).closes || [];
      const assetReturns = logReturns(assetCloses);
      const n            = Math.min(assetReturns.length, bmReturns.length);

      const rolling = [];
      for (let i = W; i <= n; i++) {
        rolling.push(_r4(_beta(assetReturns.slice(i - W, i), bmReturns.slice(i - W, i))));
      }

      const latestBeta = rolling.length ? rolling[rolling.length - 1] : null;
      const latestCorr = n >= W
        ? _r4(pearson(assetReturns.slice(-W), bmReturns.slice(-W)))
        : null;

      betaResults[sym] = {
        beta:        latestBeta,
        correlation: latestCorr,
        rollingBeta: rolling,
        dataPoints:  n,
      };
    }

    return {
      ok:        true,
      benchmark: bm,
      symbols:   syms,
      window:    W,
      timeframe,
      beta:      betaResults,
      source:    _primarySource(data),
    };
  },

  // ── Sector rotation ───────────────────────────────────────────────────────
  //
  // Ranks all sector ETFs by risk-adjusted momentum (window cumulative return
  // divided by annualized volatility, analogous to an unlevered Sharpe).
  // Returns sectors sorted best-first.

  async sectorRotation({ timeframe = '1d', window: win = 20, benchmark = 'SPY' } = {}) {
    const W  = Math.max(2, Number(win) || 20);
    const bm = String(benchmark).toUpperCase();
    const sectorSymbols = Object.values(SECTOR_ETFS);
    const allSyms       = [...new Set([bm, ...sectorSymbols])];
    const limit         = Math.min(500, W + 60);

    const data       = await _fetchMulti(allSyms, timeframe, limit);
    const bmCloses   = (data.get(bm) || {}).closes || [];
    const bmReturns  = logReturns(bmCloses);
    const bmWindowStart = bmCloses.length > W ? bmCloses[bmCloses.length - W - 1] : bmCloses[0];
    const bmWindowEnd   = bmCloses[bmCloses.length - 1];
    const bmCumReturn   = (bmWindowStart && bmWindowEnd)
      ? ((bmWindowEnd - bmWindowStart) / bmWindowStart) * 100
      : 0;

    const sectors = [];
    for (const [sectorName, etf] of Object.entries(SECTOR_ETFS)) {
      const { closes, source } = data.get(etf) || { closes: [], source: 'fallback_demo' };
      const returns    = logReturns(closes);
      const winReturns = returns.slice(-W);

      const winStart   = closes.length > W ? closes[closes.length - W - 1] : closes[0];
      const winEnd     = closes[closes.length - 1];
      const cumReturn  = (winStart && winEnd) ? ((winEnd - winStart) / winStart) * 100 : 0;

      const vol   = winReturns.length >= 2 ? annualizedVol(winReturns, timeframe) * 100 : 0;
      const score = vol > 1e-8 ? cumReturn / vol : 0;

      const bmSlice    = bmReturns.slice(-Math.min(W, bmReturns.length));
      const assetSlice = winReturns.slice(-Math.min(W, winReturns.length));
      const b          = _r4(_beta(assetSlice, bmSlice));

      sectors.push({
        sector:    sectorName,
        etf,
        cumReturn: _r4(cumReturn),
        relReturn: _r4(cumReturn - bmCumReturn),
        volatility: _r4(vol),
        score:     _r4(score),
        beta:      b,
        dataPoints: closes.length,
        source,
      });
    }

    sectors.sort((a, b2) => (b2.score ?? -Infinity) - (a.score ?? -Infinity));

    return {
      ok:                  true,
      sectors,
      benchmark:           bm,
      benchmarkCumReturn:  _r4(bmCumReturn),
      window:              W,
      timeframe,
      source:              _primarySource(data),
    };
  },

  // ── Volatility heatmap ────────────────────────────────────────────────────
  //
  // For each symbol, returns annualized volatility (as a % value, e.g. 18.5)
  // for the current window, a rolling series, and a rank among the symbol set.

  async volatilityHeatmap({ symbols, timeframe = '1d', window: win = 20 } = {}) {
    const syms  = (Array.isArray(symbols) && symbols.length)
      ? symbols.map((s) => String(s).toUpperCase())
      : ['SPY', 'QQQ', 'IWM', 'GLD', 'TLT'];
    const W     = Math.max(2, Number(win) || 20);
    const limit = Math.min(500, W + 100);

    const data    = await _fetchMulti(syms, timeframe, limit);
    const heatmap = {};

    for (const [sym, { closes, source }] of data) {
      const returns = logReturns(closes);
      const n       = returns.length;

      const rolling = [];
      for (let i = W; i <= n; i++) {
        rolling.push(_r4(annualizedVol(returns.slice(i - W, i), timeframe) * 100));
      }

      heatmap[sym] = {
        currentVol: rolling.length ? rolling[rolling.length - 1] : null,
        rollingVol: rolling,
        dataPoints: n,
        source,
      };
    }

    // Rank symbols by current vol (1 = lowest)
    const byVol = syms
      .map((s) => ({ sym: s, vol: heatmap[s]?.currentVol ?? Infinity }))
      .sort((a, b) => a.vol - b.vol);
    byVol.forEach((e, i) => { if (heatmap[e.sym]) heatmap[e.sym].volRank = i + 1; });

    return {
      ok:       true,
      heatmap,
      symbols:  syms,
      window:   W,
      timeframe,
      source:   _primarySource(data),
    };
  },

  // ── Relative performance ──────────────────────────────────────────────────
  //
  // Cumulative return for each symbol and benchmark, rebased to 100 at the
  // start of the selected window, so the relative gap is directly readable.
  // `window` is optional — if omitted uses all available data.

  async relativePerformance({ symbols, benchmark = 'SPY', timeframe = '1d', window: win = null } = {}) {
    const bm   = String(benchmark).toUpperCase();
    const syms = (Array.isArray(symbols) && symbols.length)
      ? symbols.map((s) => String(s).toUpperCase())
      : ['QQQ', 'IWM', 'GLD', 'TLT'];
    const W     = win ? Math.max(2, Number(win)) : null;
    const limit = W ? Math.min(500, W + 60) : 252;

    const data      = await _fetchMulti([bm, ...syms], timeframe, limit);
    const allBmClose = (data.get(bm) || {}).closes || [];

    const performance = {};
    for (const sym of syms) {
      const { closes, source } = data.get(sym) || { closes: [], source: 'fallback_demo' };
      const sliceLen = W
        ? Math.min(W + 1, closes.length, allBmClose.length)
        : Math.min(closes.length, allBmClose.length);

      const assetSlice = closes.slice(-sliceLen);
      const bmSlice    = allBmClose.slice(-sliceLen);
      const assetRet   = logReturns(assetSlice);
      const bmRet      = logReturns(bmSlice);

      // Build rebased-to-100 cumulative series
      let cumA = 100; let cumB = 100;
      const cumSeries = [{ asset: 100, benchmark: 100, relative: 0 }];
      const n2 = Math.min(assetRet.length, bmRet.length);
      for (let i = 0; i < n2; i++) {
        cumA *= Math.exp(assetRet[i] || 0);
        cumB *= Math.exp(bmRet[i]    || 0);
        cumSeries.push({
          asset:     _r4(cumA),
          benchmark: _r4(cumB),
          relative:  _r4(cumA - cumB),
        });
      }

      const totalReturn = assetSlice.length >= 2
        ? ((assetSlice[assetSlice.length - 1] - assetSlice[0]) / assetSlice[0]) * 100 : 0;
      const bmReturn = bmSlice.length >= 2
        ? ((bmSlice[bmSlice.length - 1] - bmSlice[0]) / bmSlice[0]) * 100 : 0;

      performance[sym] = {
        totalReturn:     _r4(totalReturn),
        benchmarkReturn: _r4(bmReturn),
        relativeReturn:  _r4(totalReturn - bmReturn),
        cumSeries,
        dataPoints:      assetSlice.length,
        source,
      };
    }

    return {
      ok:          true,
      benchmark:   bm,
      symbols:     syms,
      timeframe,
      window:      W,
      performance,
      source:      _primarySource(data),
    };
  },
};
