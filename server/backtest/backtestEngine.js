import { strategyEngine } from '../strategies/strategyEngine.js';
import * as historicalStore from '../persistence/historicalStore.js';
import { createBacktestTrade } from './backtestTrade.js';
import { createBacktestResult } from './backtestResult.js';

const DEFAULTS = {
  quantity: 1,
  commissionPerTrade: 0.0,
  slippagePercent: 0.0005,
  stopLossPercent: 0.01,
  takeProfitPercent: 0.02,
  maxHoldingCandles: 10,
};

class BacktestEngine {
  constructor() {
    this.resultsBySymbol = new Map();
  }

  runBacktest(symbol, strategyId, timeframe = '1m') {
    const normalized = String(symbol || '').toUpperCase();
    const strategies = strategyEngine.getStrategies(normalized);
    const warnings = [];

    if (!strategies.length) {
      warnings.push('No strategy candidates available; run strategy generation first.');
      const result = createBacktestResult({ symbol: normalized, timeframe, trades: [], warnings, metrics: this.calculateMetrics([]) });
      this.#saveResult(normalized, result);
      return result;
    }

    const chosen = strategyId
      ? strategies.find((s) => s.id === strategyId)
      : strategies[strategies.length - 1];

    if (!chosen) {
      warnings.push(`Strategy id ${strategyId} not found; no backtest run.`);
      const result = createBacktestResult({ symbol: normalized, timeframe, trades: [], warnings, metrics: this.calculateMetrics([]) });
      this.#saveResult(normalized, result);
      return result;
    }

    return this.runBacktestFromCandidate(normalized, chosen, timeframe);
  }

  runBacktestFromCandidate(symbol, candidate, timeframe = '1m') {
    const normalized = String(symbol || '').toUpperCase();
    const candleData = historicalStore.getCandlesWithMeta(normalized, timeframe);
    const candles = candleData?.candles;
    const warnings = [];

    if (!Array.isArray(candles) || candles.length === 0) {
      warnings.push('No historical candles available for requested symbol/timeframe.');
      const result = createBacktestResult({
        symbol: normalized,
        strategyId: candidate?.id || '',
        strategyName: candidate?.name || 'Unknown Strategy',
        timeframe,
        trades: [],
        metrics: this.calculateMetrics([]),
        warnings,
      });
      this.#saveResult(normalized, result);
      return result;
    }

    const trades = this.simulateTrades(candles, candidate);
    const resultWarnings = Array.isArray(candidate?.warnings) ? [...candidate.warnings] : [];
    if (candleData?.isFallbackDemo) {
      resultWarnings.push('Backtest used fallback demo candles; not suitable for trading decisions.');
    }
    if (candidate?.type === 'test_candidate' || candidate?.status === 'research_only') {
      resultWarnings.push('Backtest run uses research-only candidate and is not a validation of live profitability.');
    }
    const result = createBacktestResult({
      symbol: normalized,
      strategyId: candidate?.id || '',
      strategyName: candidate?.name || 'Unknown Strategy',
      timeframe,
      trades,
      metrics: this.calculateMetrics(trades),
      warnings: resultWarnings,
    });

    this.#saveResult(normalized, result);
    return result;
  }

  simulateTrades(candles = [], strategyCandidate = {}) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const direction = strategyCandidate?.direction === 'short' ? 'short' : 'long';
    const entryIndex = candles.length > 1 ? 1 : 0;
    const entryCandle = candles[entryIndex];
    const entryRawPrice = Number(entryCandle?.o ?? entryCandle?.c ?? 0);
    const slippageSigned = direction === 'long' ? DEFAULTS.slippagePercent : -DEFAULTS.slippagePercent;
    const entryPrice = entryRawPrice * (1 + slippageSigned);

    const stopPrice = direction === 'long'
      ? entryPrice * (1 - DEFAULTS.stopLossPercent)
      : entryPrice * (1 + DEFAULTS.stopLossPercent);
    const targetPrice = direction === 'long'
      ? entryPrice * (1 + DEFAULTS.takeProfitPercent)
      : entryPrice * (1 - DEFAULTS.takeProfitPercent);

    let exitCandle = candles[candles.length - 1];
    let exitPrice = Number(exitCandle?.c ?? entryPrice);
    let reason = 'max_holding_period';

    const endIndex = Math.min(candles.length - 1, entryIndex + DEFAULTS.maxHoldingCandles);
    for (let i = entryIndex + 1; i <= endIndex; i += 1) {
      const candle = candles[i];
      if (!candle) continue;

      if (direction === 'long' && Number(candle.l) <= stopPrice) {
        exitCandle = candle;
        exitPrice = stopPrice;
        reason = 'stop_loss';
        break;
      }
      if (direction === 'short' && Number(candle.h) >= stopPrice) {
        exitCandle = candle;
        exitPrice = stopPrice;
        reason = 'stop_loss';
        break;
      }
      if (direction === 'long' && Number(candle.h) >= targetPrice) {
        exitCandle = candle;
        exitPrice = targetPrice;
        reason = 'take_profit';
        break;
      }
      if (direction === 'short' && Number(candle.l) <= targetPrice) {
        exitCandle = candle;
        exitPrice = targetPrice;
        reason = 'take_profit';
        break;
      }

      if (i === endIndex) {
        exitCandle = candle;
        exitPrice = Number(candle.c ?? entryPrice);
      }
    }

    const exitSlippageSigned = direction === 'long' ? -DEFAULTS.slippagePercent : DEFAULTS.slippagePercent;
    exitPrice *= (1 + exitSlippageSigned);

    const grossPnL = direction === 'long'
      ? (exitPrice - entryPrice) * DEFAULTS.quantity
      : (entryPrice - exitPrice) * DEFAULTS.quantity;
    const netPnL = grossPnL - DEFAULTS.commissionPerTrade;
    const pnlPercent = entryPrice ? (netPnL / (entryPrice * DEFAULTS.quantity)) * 100 : 0;

    return [createBacktestTrade({
      symbol: strategyCandidate?.symbol || '',
      strategyId: strategyCandidate?.id || '',
      direction,
      entryTime: new Date(Number(entryCandle?.t) || Date.now()).toISOString(),
      entryPrice,
      exitTime: new Date(Number(exitCandle?.t) || Date.now()).toISOString(),
      exitPrice,
      quantity: DEFAULTS.quantity,
      pnl: netPnL,
      pnlPercent,
      reason,
    })];
  }

  calculateMetrics(trades = []) {
    const safeTrades = Array.isArray(trades) ? trades : [];
    const pnls = safeTrades.map((t) => Number(t.pnl) || 0);
    const totalPnL = pnls.reduce((a, b) => a + b, 0);
    const wins = safeTrades.filter((t) => (Number(t.pnl) || 0) > 0);
    const losses = safeTrades.filter((t) => (Number(t.pnl) || 0) < 0);
    const numberOfTrades = safeTrades.length;
    const winRate = numberOfTrades ? wins.length / numberOfTrades : 0;
    const lossRate = numberOfTrades ? losses.length / numberOfTrades : 0;
    const averageWin = wins.length ? wins.reduce((a, t) => a + (Number(t.pnl) || 0), 0) / wins.length : 0;
    const averageLoss = losses.length ? losses.reduce((a, t) => a + (Number(t.pnl) || 0), 0) / losses.length : 0;

    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const p of pnls) {
      equity += p;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.min(maxDrawdown, equity - peak);
    }

    const grossProfit = wins.reduce((a, t) => a + (Number(t.pnl) || 0), 0);
    const grossLossAbs = Math.abs(losses.reduce((a, t) => a + (Number(t.pnl) || 0), 0));
    const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0);
    const expectancy = numberOfTrades ? totalPnL / numberOfTrades : 0;
    const totalPnLPercent = safeTrades.reduce((a, t) => a + (Number(t.pnlPercent) || 0), 0);

    const durations = safeTrades.map((t) => {
      const start = Date.parse(t.entryTime);
      const end = Date.parse(t.exitTime);
      return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    });
    const averageTradeDuration = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    return {
      totalPnL,
      totalPnLPercent,
      winRate,
      lossRate,
      averageWin,
      averageLoss,
      maxDrawdown,
      profitFactor: Number.isFinite(profitFactor) ? profitFactor : null,
      expectancy,
      numberOfTrades,
      averageTradeDuration,
    };
  }

  getBacktestResults(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    return this.resultsBySymbol.get(normalized) || [];
  }

  getBacktestResultById(symbol, id) {
    return this.getBacktestResults(symbol).find((r) => r.id === id) || null;
  }

  clearBacktestResults(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    this.resultsBySymbol.delete(normalized);
    return [];
  }

  #saveResult(symbol, result) {
    const existing = this.getBacktestResults(symbol);
    this.resultsBySymbol.set(symbol, [...existing, result]);
  }
}

export const backtestEngine = new BacktestEngine();
