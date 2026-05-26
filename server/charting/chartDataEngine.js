import { getCandlesWithMeta } from '../persistence/historicalStore.js';
import { feedManager } from '../feeds/feedManager.js';
import { reversalDetectorEngine } from '../reversal/reversalDetectorEngine.js';
import { strategyEngine } from '../strategies/strategyEngine.js';
import { backtestEngine } from '../backtest/backtestEngine.js';
import { paperTradingEngine } from '../paperTrading/paperTradingEngine.js';
import { createChartCandle, createChartIndicator, createChartOverlay, createOrderflowSnapshot } from './models.js';

function ema(values = [], period = 9) { const k = 2 / (period + 1); let prev = values[0] || 0; return values.map((v, i) => { if (i === 0) return prev; prev = (v * k) + (prev * (1 - k)); return prev; }); }
function rsi(values = [], period = 14) {
  if (values.length < 2) return values.map(() => 50);

  const out = [50];
  let gainSum = 0;
  let lossSum = 0;
  let avgGain = null;
  let avgLoss = null;

  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);

    if (i <= period) {
      gainSum += gain;
      lossSum += loss;
      if (i < period) {
        out.push(50);
        continue;
      }
      avgGain = gainSum / period;
      avgLoss = lossSum / period;
    } else {
      avgGain = ((avgGain * (period - 1)) + gain) / period;
      avgLoss = ((avgLoss * (period - 1)) + loss) / period;
    }

    if (avgLoss === 0) {
      out.push(avgGain === 0 ? 50 : 100);
      continue;
    }
    const rs = avgGain / avgLoss;
    out.push(100 - (100 / (1 + rs)));
  }
  return out;
}

class ChartDataEngine {
  getCandles(symbol, timeframe = '1m', limit = 200) {
    const s = String(symbol || 'SPY').toUpperCase();
    const payload = getCandlesWithMeta(s, timeframe);
    const source = payload?.source || 'fallback_demo';
    const candles = Array.isArray(payload?.candles) ? payload.candles.slice(-Math.max(1, Number(limit) || 200)) : [];
    return {
      symbol: s,
      timeframe,
      source,
      warnings: payload?.isFallbackDemo ? [payload.warning || 'Fallback demo candles used.'] : [],
      candles: candles.map((c) => createChartCandle({ symbol: s, timeframe, time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v, source: c.source || source })),
    };
  }

  getIndicators(symbol, timeframe = '1m', indicators = ['vwap', 'ema9', 'ema20', 'rsi14', 'volume_avg', 'volume_zscore']) {
    const candlePayload = this.getCandles(symbol, timeframe, 400);
    const candles = candlePayload.candles;
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const vwapVals = []; let cumPv = 0; let cumV = 0;
    for (const c of candles) { cumPv += c.close * c.volume; cumV += c.volume; vwapVals.push({ time: c.time, value: cumV ? cumPv / cumV : c.close }); }
    const ema9 = ema(closes, 9).map((value, i) => ({ time: candles[i]?.time, value }));
    const ema20 = ema(closes, 20).map((value, i) => ({ time: candles[i]?.time, value }));
    const rsi14 = rsi(closes, 14).map((value, i) => ({ time: candles[i]?.time, value }));
    const volAvg = volumes.map((_, i) => {
      const start = Math.max(0, i - 19); const slice = volumes.slice(start, i + 1); const avg = slice.reduce((a, b) => a + b, 0) / slice.length; return { time: candles[i]?.time, value: avg };
    });
    const volMean = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
    const volStd = volumes.length ? Math.sqrt(volumes.reduce((a, v) => a + ((v - volMean) ** 2), 0) / volumes.length) : 0;
    const volZ = volumes.map((v, i) => ({ time: candles[i]?.time, value: volStd > 0 ? (v - volMean) / volStd : 0 }));
    const map = { vwap: vwapVals, ema9, ema20, rsi14, volume_avg: volAvg, volume_zscore: volZ };
    const items = indicators.map((name) => String(name).trim().toLowerCase()).filter((name) => map[name]).map((name) => createChartIndicator({ symbol, timeframe, name, values: map[name], source: candlePayload.source }));
    const warnings = [...candlePayload.warnings];
    if (!candles.length) warnings.push('No candles available for indicator computation.');
    if (candles.length < 20) warnings.push('Limited candles: some indicators may be unstable.');
    return { symbol: String(symbol || 'SPY').toUpperCase(), timeframe, source: candlePayload.source, warnings, indicators: items };
  }

  getOverlays(symbol, timeframe = '1m') {
    const s = String(symbol || 'SPY').toUpperCase();
    const overlays = [];
    for (const p of reversalDetectorEngine.getReversalPoints(s)) overlays.push(createChartOverlay({ symbol: s, type: 'reversal_point', label: p.grade || 'reversal', time: Date.parse(p.createdAt) || Date.now(), price: p.zone?.price || p.zone?.vwap || 0, direction: p.direction || 'neutral', metadata: p, source: p.source || 'reversal_detector' }));
    for (const st of strategyEngine.getStrategies(s)) overlays.push(createChartOverlay({ symbol: s, type: 'strategy_candidate', label: st.name || 'strategy', time: Date.parse(st.createdAt) || Date.now(), price: 0, direction: st.direction || 'neutral', metadata: st, source: 'strategy_engine' }));
    for (const result of backtestEngine.getBacktestResults(s)) for (const trade of (result?.trades || [])) overlays.push(createChartOverlay({ symbol: s, type: 'backtest_trade', label: trade.reason || 'trade', time: Date.parse(trade.entryTime) || Date.now(), price: trade.entryPrice || 0, direction: trade.direction || 'neutral', metadata: trade, source: 'backtest_engine' }));
    for (const fill of paperTradingEngine.getFills(s)) overlays.push(createChartOverlay({ symbol: s, type: 'paper_fill', label: fill.side || 'fill', time: Date.parse(fill.timestamp) || Date.now(), price: fill.price || 0, direction: fill.side === 'buy' ? 'long' : 'short', metadata: fill, source: 'paper_trading' }));
    return { symbol: s, timeframe, source: overlays.length ? 'mixed' : 'none', warnings: [], overlays };
  }

  getOrderflow(symbol) {
    const s = String(symbol || 'SPY').toUpperCase();
    const ob = feedManager.getLatestOrderBook(s);
    if (!ob) return { symbol: s, warnings: ['No orderbook available from feedManager.'], orderflow: createOrderflowSnapshot({ symbol: s, bids: [], asks: [], spread: 0, imbalance: 0, liquidityPressure: 0, source: 'unavailable' }) };
    const bidSize = (ob.bids || []).reduce((acc, x) => acc + Number(x[1] || 0), 0);
    const askSize = (ob.asks || []).reduce((acc, x) => acc + Number(x[1] || 0), 0);
    const imbalance = (bidSize + askSize) > 0 ? bidSize / (bidSize + askSize) : 0;
    return { symbol: s, warnings: ob.source === 'fallback_demo' ? ['Orderbook source is fallback_demo and not live.'] : [], orderflow: createOrderflowSnapshot({ symbol: s, bids: ob.bids || [], asks: ob.asks || [], spread: ob.spread || 0, imbalance, liquidityPressure: imbalance - 0.5, source: ob.source || 'unknown', timestamp: ob.timestamp || new Date().toISOString() }) };
  }

  buildChartPayload(symbol, timeframe = '1m', limit = 200) {
    const candles = this.getCandles(symbol, timeframe, limit);
    const indicators = this.getIndicators(symbol, timeframe, ['vwap', 'ema9', 'ema20', 'rsi14', 'volume_avg', 'volume_zscore']);
    const overlays = this.getOverlays(symbol, timeframe);
    const orderflow = this.getOrderflow(symbol);
    return { symbol: candles.symbol, timeframe, source: candles.source, warnings: [...candles.warnings, ...indicators.warnings, ...orderflow.warnings], candles: candles.candles, indicators: indicators.indicators, overlays: overlays.overlays, orderflow: orderflow.orderflow };
  }
}

export const chartDataEngine = new ChartDataEngine();
