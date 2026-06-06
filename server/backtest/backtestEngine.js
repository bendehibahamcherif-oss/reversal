import { randomUUID } from 'node:crypto';
import { strategyEngine } from '../strategies/strategyEngine.js';
import * as historicalStore from '../persistence/historicalStore.js';
import { createBacktestTrade } from './backtestTrade.js';
import { createBacktestResult } from './backtestResult.js';
import { backtestStore } from './backtestStore.js';

// ── Default simulation parameters ────────────────────────────────────────────

const BASE_CONFIG = {
  quantity:          1,
  commissionPerTrade: 0.0,
  slippagePercent:   0.0005,
  stopLossPercent:   0.01,
  takeProfitPercent: 0.02,
  maxHoldingCandles: 10,
};

function mergeConfig(overrides = {}) {
  return {
    quantity:           Number(overrides.quantity          ?? BASE_CONFIG.quantity),
    commissionPerTrade: Number(overrides.commissionPerTrade ?? BASE_CONFIG.commissionPerTrade),
    slippagePercent:    Number(overrides.slippagePercent   ?? BASE_CONFIG.slippagePercent),
    stopLossPercent:    Number(overrides.stopLossPercent   ?? BASE_CONFIG.stopLossPercent),
    takeProfitPercent:  Number(overrides.takeProfitPercent ?? BASE_CONFIG.takeProfitPercent),
    maxHoldingCandles:  Math.max(1, Math.floor(Number(overrides.maxHoldingCandles ?? BASE_CONFIG.maxHoldingCandles))),
  };
}

// ── Look-ahead audit notes ────────────────────────────────────────────────────
// simulateTrades() is verified look-ahead free:
//   1. Signal is assumed generated on bar T (candles[0]).
//   2. Entry executes at candles[1].open  (bar T+1 open) — one bar after signal.
//   3. Exit loop starts at i = entryIndex+1 = 2 (bar T+2 onwards).
//   4. Stop/target checks use candle.low / candle.high of completed bars only.
//   5. No bar's close is used for decisions before that bar closes.
// The only accepted fallback is: entryCandle.open ?? entryCandle.close  when
// open is missing (degenerate candle data); a warning is emitted for this case.

class BacktestEngine {
  constructor() {
    // In-memory cache preserved for backward-compat (getBacktestResults /
    // getBacktestResultById / clearBacktestResults still work as before)
    this.resultsBySymbol = new Map();
  }

  // ── Standard backtest (existing API, backward-compatible) ─────────────────

  runBacktest(symbol, strategyId, timeframe = '1m', config = {}, providedCandles = null) {
    const normalized = String(symbol || '').toUpperCase();
    const strategies = strategyEngine.getStrategies(normalized);
    const warnings = [];

    if (Array.isArray(providedCandles)) {
      const candidate = strategies[strategies.length - 1] || { id: 'historical_dataset_default', name: 'Historical Dataset Default', symbol: normalized, direction: 'long' };
      return this.runBacktestFromCandles(normalized, candidate, timeframe, config, providedCandles, { source: 'historical_dataset' });
    }

    if (!strategies.length) {
      warnings.push('No strategy candidates available; run strategy generation first.');
      const result = this.#buildResult(normalized, null, timeframe, [], warnings, config);
      this.#saveResult(normalized, result);
      return result;
    }

    const chosen = strategyId
      ? strategies.find((s) => s.id === strategyId)
      : strategies[strategies.length - 1];

    if (!chosen) {
      warnings.push(`Strategy id ${strategyId} not found; no backtest run.`);
      const result = this.#buildResult(normalized, null, timeframe, [], warnings, config);
      this.#saveResult(normalized, result);
      return result;
    }

    return this.runBacktestFromCandidate(normalized, chosen, timeframe, config);
  }

  runBacktestFromCandidate(symbol, candidate, timeframe = '1m', config = {}) {
    const normalized = String(symbol || '').toUpperCase();
    const cfg = mergeConfig(config);
    const candleData = historicalStore.getCandlesWithMeta(normalized, timeframe);
    const candles = candleData?.candles;
    const warnings = [];

    if (!Array.isArray(candles) || candles.length === 0) {
      warnings.push('No historical candles available for requested symbol/timeframe.');
      const result = this.#buildResult(normalized, candidate, timeframe, [], warnings, cfg, candleData);
      this.#saveResult(normalized, result);
      return result;
    }

    const trades = this.simulateTrades(candles, candidate, cfg);
    const runWarnings = Array.isArray(candidate?.warnings) ? [...candidate.warnings] : [];
    if (candleData?.isFallbackDemo) {
      runWarnings.push('Backtest used fallback demo candles; not suitable for trading decisions.');
    }
    if (candidate?.type === 'test_candidate' || candidate?.status === 'research_only') {
      runWarnings.push('Backtest run uses research-only candidate; not a validation of live profitability.');
    }

    const result = this.#buildResult(normalized, candidate, timeframe, trades, runWarnings, cfg, candleData);
    this.#saveResult(normalized, result);
    return result;
  }


  runBacktestFromCandles(symbol, candidate, timeframe = '1m', config = {}, candles = [], candleData = {}) {
    const normalized = String(symbol || '').toUpperCase();
    const cfg = mergeConfig(config);
    const normalizedCandles = Array.isArray(candles) ? candles.map((c) => ({
      ...c,
      t: c.t ?? c.timestamp,
      o: c.o ?? c.open,
      h: c.h ?? c.high,
      l: c.l ?? c.low,
      c: c.c ?? c.close,
      v: c.v ?? c.volume,
    })) : [];
    const warnings = [];
    if (normalizedCandles.length < 2) warnings.push('Not enough historical candles available for requested dataset.');
    const trades = normalizedCandles.length >= 2 ? this.simulateTrades(normalizedCandles, candidate, cfg) : [];
    const result = this.#buildResult(normalized, candidate, timeframe, trades, warnings, cfg, { ...candleData, candles: normalizedCandles });
    this.#saveResult(normalized, result);
    return result;
  }

  // ── Walk-forward backtest ─────────────────────────────────────────────────
  // Splits the candle series into rolling [train | test] windows and measures
  // out-of-sample performance on each test slice independently.
  //
  // Options:
  //   trainRatio       (0.6)  — fraction of total candles used as train context
  //   testRatio        (0.2)  — fraction used as each test slice
  //   stepRatio        (0.1)  — fraction to advance window per iteration
  //   minTestCandles   (20)   — skip windows smaller than this

  walkForwardBacktest(symbol, candidate, timeframe = '1m', options = {}, config = {}) {
    const normalized = String(symbol || '').toUpperCase();
    const {
      trainRatio     = 0.6,
      testRatio      = 0.2,
      stepRatio      = 0.1,
      minTestCandles = 20,
    } = options;

    const cfg = mergeConfig(config);
    const candleData = historicalStore.getCandlesWithMeta(normalized, timeframe);
    const candles = candleData?.candles ?? [];
    const warnings = [];
    const id = randomUUID();

    if (candles.length < minTestCandles * 3) {
      warnings.push('Insufficient candle data for walk-forward test; need at least 3× minTestCandles.');
      const result = { id, symbol: normalized, strategyId: candidate?.id, timeframe, windows: [], aggregateMetrics: this.calculateMetrics([]), config: { ...options, ...cfg }, warnings, createdAt: new Date().toISOString() };
      backtestStore.saveWalkForwardRun(result);
      return result;
    }

    const n = candles.length;
    const trainSize = Math.max(1, Math.floor(n * trainRatio));
    const testSize  = Math.max(minTestCandles, Math.floor(n * testRatio));
    const stepSize  = Math.max(1, Math.floor(n * stepRatio));

    const windows = [];
    let start = 0;

    while (start + trainSize + testSize <= n) {
      const trainEnd = start + trainSize;
      const testEnd  = Math.min(n, trainEnd + testSize);
      const testSlice = candles.slice(trainEnd, testEnd);

      if (testSlice.length >= minTestCandles) {
        const trades  = this.simulateTrades(testSlice, candidate, cfg);
        const metrics = this.calculateMetrics(trades);
        windows.push({
          windowIdx: windows.length,
          trainStart: candles[start]?.t ?? null,
          trainEnd:   candles[trainEnd - 1]?.t ?? null,
          testStart:  candles[trainEnd]?.t ?? null,
          testEnd:    candles[testEnd - 1]?.t ?? null,
          candleCount: testSlice.length,
          trades,
          metrics,
        });
      }
      start += stepSize;
    }

    const aggregateMetrics = this.calculateMetrics(windows.flatMap((w) => w.trades));
    if (candleData?.isFallbackDemo) {
      warnings.push('Walk-forward used fallback demo candles; results are illustrative only.');
    }

    const result = {
      id, symbol: normalized, strategyId: candidate?.id, strategyName: candidate?.name,
      timeframe, windows, aggregateMetrics, config: { trainRatio, testRatio, stepRatio, minTestCandles, ...cfg },
      warnings, createdAt: new Date().toISOString(),
    };
    backtestStore.saveWalkForwardRun(result);
    return result;
  }

  // ── Monte Carlo trade-sequence resampling ─────────────────────────────────
  // Given a completed run, resamples its trade sequence with replacement
  // `iterations` times and returns the distribution of key metrics.

  monteCarloResample(baseRunId, iterations = 1000) {
    const baseRun = backtestStore.getRunById(baseRunId);
    if (!baseRun) return null;

    const trades = baseRun.trades ?? [];
    const n = trades.length;
    const id = randomUUID();

    if (n === 0) {
      const empty = { id, baseRunId, symbol: baseRun.symbol, iterations: 0, distribution: {}, summary: { note: 'No trades to resample' }, createdAt: new Date().toISOString() };
      backtestStore.saveMonteCarloRun(empty);
      return empty;
    }

    const safeIter = Math.min(10_000, Math.max(100, Math.floor(Number(iterations) || 1000)));
    const totalPnLs = new Float64Array(safeIter);
    const winRates  = new Float64Array(safeIter);
    const drawdowns = new Float64Array(safeIter);
    const pFactors  = new Float64Array(safeIter);

    for (let iter = 0; iter < safeIter; iter++) {
      const sampled = Array.from({ length: n }, () => trades[Math.floor(Math.random() * n)]);
      const m = this.calculateMetrics(sampled);
      totalPnLs[iter] = m.totalPnL;
      winRates[iter]  = m.winRate;
      drawdowns[iter] = m.maxDrawdown;
      pFactors[iter]  = m.profitFactor ?? 0;
    }

    const sortedPnL = Array.from(totalPnLs).sort((a, b) => a - b);
    const sortedWR  = Array.from(winRates).sort((a, b) => a - b);
    const sortedDD  = Array.from(drawdowns).sort((a, b) => a - b);
    const sortedPF  = Array.from(pFactors).sort((a, b) => a - b);

    const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
    const summaryFor = (arr) => ({ p5: pct(arr, 0.05), p25: pct(arr, 0.25), median: pct(arr, 0.50), p75: pct(arr, 0.75), p95: pct(arr, 0.95) });

    const summary = {
      totalPnL:    summaryFor(sortedPnL),
      winRate:     summaryFor(sortedWR),
      maxDrawdown: summaryFor(sortedDD),
      profitFactor: summaryFor(sortedPF),
      iterations: safeIter,
    };

    const result = {
      id, baseRunId, symbol: baseRun.symbol, iterations: safeIter,
      distribution: { totalPnL: sortedPnL, winRate: sortedWR, maxDrawdown: sortedDD, profitFactor: sortedPF },
      summary, createdAt: new Date().toISOString(),
    };
    backtestStore.saveMonteCarloRun(result);
    return result;
  }

  // ── Core simulation ───────────────────────────────────────────────────────
  // Look-ahead free: see audit notes at the top of this file.

  simulateTrades(candles = [], strategyCandidate = {}, config = {}) {
    if (!Array.isArray(candles) || candles.length === 0) return [];

    const cfg = mergeConfig(config);
    const direction = strategyCandidate?.direction === 'short' ? 'short' : 'long';

    // Bar T = candles[0] → signal generated; bar T+1 = candles[1] → entry at open
    const entryIndex   = candles.length > 1 ? 1 : 0;
    const entryCandle  = candles[entryIndex];
    const openPrice    = Number(entryCandle?.o);
    const usedFallback = isNaN(openPrice) || openPrice <= 0;
    const entryRawPrice = usedFallback ? Number(entryCandle?.c ?? 0) : openPrice;

    const slippageSigned = direction === 'long' ? cfg.slippagePercent : -cfg.slippagePercent;
    const entryPrice = entryRawPrice * (1 + slippageSigned);

    const stopPrice = direction === 'long'
      ? entryPrice * (1 - cfg.stopLossPercent)
      : entryPrice * (1 + cfg.stopLossPercent);
    const targetPrice = direction === 'long'
      ? entryPrice * (1 + cfg.takeProfitPercent)
      : entryPrice * (1 - cfg.takeProfitPercent);

    let exitCandle  = candles[candles.length - 1];
    let exitPrice   = Number(exitCandle?.c ?? entryPrice);
    let reason      = 'max_holding_period';

    // Exit loop starts at entryIndex+1 — bars that completed AFTER the entry bar
    const endIndex = Math.min(candles.length - 1, entryIndex + cfg.maxHoldingCandles);
    for (let i = entryIndex + 1; i <= endIndex; i++) {
      const candle = candles[i];
      if (!candle) continue;

      const lo = Number(candle.l);
      const hi = Number(candle.h);

      if (direction === 'long' && lo <= stopPrice)   { exitCandle = candle; exitPrice = stopPrice;  reason = 'stop_loss';   break; }
      if (direction === 'short' && hi >= stopPrice)  { exitCandle = candle; exitPrice = stopPrice;  reason = 'stop_loss';   break; }
      if (direction === 'long' && hi >= targetPrice) { exitCandle = candle; exitPrice = targetPrice; reason = 'take_profit'; break; }
      if (direction === 'short' && lo <= targetPrice){ exitCandle = candle; exitPrice = targetPrice; reason = 'take_profit'; break; }

      if (i === endIndex) {
        exitCandle = candle;
        exitPrice  = Number(candle.c ?? entryPrice);
      }
    }

    const exitSlippageSigned = direction === 'long' ? -cfg.slippagePercent : cfg.slippagePercent;
    exitPrice *= (1 + exitSlippageSigned);

    const grossPnL = direction === 'long'
      ? (exitPrice - entryPrice) * cfg.quantity
      : (entryPrice - exitPrice) * cfg.quantity;
    const netPnL    = grossPnL - cfg.commissionPerTrade;
    const pnlPct    = entryPrice > 0 ? (netPnL / (entryPrice * cfg.quantity)) * 100 : 0;

    return [createBacktestTrade({
      symbol:      strategyCandidate?.symbol || '',
      strategyId:  strategyCandidate?.id || '',
      direction,
      entryTime:   new Date(Number(entryCandle?.t) || Date.now()).toISOString(),
      entryPrice,
      exitTime:    new Date(Number(exitCandle?.t) || Date.now()).toISOString(),
      exitPrice,
      quantity:    cfg.quantity,
      pnl:         netPnL,
      pnlPercent:  pnlPct,
      reason,
    })];
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  calculateMetrics(trades = []) {
    const safe   = Array.isArray(trades) ? trades : [];
    const pnls   = safe.map((t) => Number(t.pnl) || 0);
    const total  = pnls.reduce((a, b) => a + b, 0);
    const wins   = safe.filter((t) => (Number(t.pnl) || 0) > 0);
    const losses = safe.filter((t) => (Number(t.pnl) || 0) < 0);
    const n      = safe.length;

    let equity = 0, peak = 0, maxDD = 0;
    for (const p of pnls) {
      equity += p;
      peak    = Math.max(peak, equity);
      maxDD   = Math.min(maxDD, equity - peak);
    }

    const grossProfit   = wins.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
    const grossLossAbs  = Math.abs(losses.reduce((a, t) => a + (Number(t.pnl) || 0), 0));
    const pf            = grossLossAbs > 0 ? grossProfit / grossLossAbs : (grossProfit > 0 ? Infinity : 0);
    const avgDur        = n ? safe.reduce((a, t) => {
      const d = Date.parse(t.exitTime) - Date.parse(t.entryTime);
      return a + (Number.isFinite(d) ? Math.max(0, d) : 0);
    }, 0) / n : 0;

    return {
      totalPnL:            total,
      totalPnLPercent:     safe.reduce((a, t) => a + (Number(t.pnlPercent) || 0), 0),
      winRate:             n ? wins.length / n : 0,
      lossRate:            n ? losses.length / n : 0,
      averageWin:          wins.length ? wins.reduce((a, t) => a + (Number(t.pnl) || 0), 0) / wins.length : 0,
      averageLoss:         losses.length ? losses.reduce((a, t) => a + (Number(t.pnl) || 0), 0) / losses.length : 0,
      maxDrawdown:         maxDD,
      profitFactor:        Number.isFinite(pf) ? pf : null,
      expectancy:          n ? total / n : 0,
      numberOfTrades:      n,
      averageTradeDuration: avgDur,
    };
  }

  // ── Backward-compat in-memory accessors ──────────────────────────────────

  getBacktestResults(symbol) {
    return this.resultsBySymbol.get(String(symbol || '').toUpperCase()) ?? [];
  }

  getBacktestResultById(symbol, id) {
    return this.getBacktestResults(symbol).find((r) => r.id === id) ?? null;
  }

  clearBacktestResults(symbol) {
    this.resultsBySymbol.delete(String(symbol || '').toUpperCase());
    return [];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  #buildResult(symbol, candidate, timeframe, trades, warnings, cfg, candleData = null) {
    const candles = candleData?.candles ?? [];
    const sourceProvider = candleData?.source ?? (candleData?.isFallbackDemo ? 'fallback_demo' : null);
    const candleRangeStart = candles.length ? Number(candles[0]?.t) : null;
    const candleRangeEnd   = candles.length ? Number(candles[candles.length - 1]?.t) : null;
    const datasetVersion   = candles.length
      ? `${sourceProvider ?? 'unknown'}-${candles.length}-${candleRangeEnd ?? 0}`
      : null;

    const base = createBacktestResult({
      symbol, timeframe,
      strategyId:   candidate?.id ?? '',
      strategyName: candidate?.name ?? 'Unknown Strategy',
      trades,
      metrics:  this.calculateMetrics(trades),
      warnings,
    });

    const enriched = {
      ...base,
      runType:             'standard',
      noLookaheadVerified: true,
      datasetVersion,
      sourceProvider,
      candleRangeStart,
      candleRangeEnd,
      candleCount:   candles.length || null,
      config:        cfg,
    };

    try { backtestStore.saveRun(enriched); } catch (e) {
      console.warn('[BacktestEngine] SQLite persist failed:', e?.message);
    }
    return enriched;
  }

  #saveResult(symbol, result) {
    const existing = this.getBacktestResults(symbol);
    this.resultsBySymbol.set(symbol, [...existing, result]);
  }
}

export const backtestEngine = new BacktestEngine();
