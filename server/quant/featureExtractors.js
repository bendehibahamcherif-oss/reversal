import { createQuantFeature } from './quantFeature.js';

function mean(values = []) {
  if (!values.length) return 0;
  return values.reduce((acc, x) => acc + x, 0) / values.length;
}

function stdDev(values = []) {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, x) => acc + ((x - m) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function ema(values = [], period = 10) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    result.push((values[i] * k) + (result[i - 1] * (1 - k)));
  }
  return result;
}

export function extractCandleFeatures(symbol, candles = [], timeframe = '1m') {
  if (!Array.isArray(candles) || candles.length < 2) return [];

  const closes = candles.map((c) => Number(c?.c) || 0);
  const opens = candles.map((c) => Number(c?.o) || 0);
  const highs = candles.map((c) => Number(c?.h) || 0);
  const lows = candles.map((c) => Number(c?.l) || 0);
  const volumes = candles.map((c) => Number(c?.v) || 0);

  const returns = closes.slice(1).map((close, idx) => {
    const prev = closes[idx] || 0;
    return prev === 0 ? 0 : (close - prev) / prev;
  });

  const latestOpen = opens[opens.length - 1] || 0;
  const latestClose = closes[closes.length - 1] || 0;
  const latestHigh = highs[highs.length - 1] || 0;
  const latestLow = lows[lows.length - 1] || 0;
  const latestVolume = volumes[volumes.length - 1] || 0;

  const range = Math.max(latestHigh - latestLow, 0);
  const body = Math.abs(latestClose - latestOpen);
  const upperWick = Math.max(latestHigh - Math.max(latestOpen, latestClose), 0);
  const lowerWick = Math.max(Math.min(latestOpen, latestClose) - latestLow, 0);

  const ranges = candles.map((c) => Math.max((Number(c?.h) || 0) - (Number(c?.l) || 0), 0));
  const priorAvgRange = mean(ranges.slice(0, -1));

  const volMean = mean(volumes);
  const volStd = stdDev(volumes);

  return [
    createQuantFeature({ symbol, category: 'candle', name: 'returns', value: mean(returns), timeframe, source: 'candles', confidence: 0.8, metadata: { sampleSize: returns.length } }),
    createQuantFeature({ symbol, category: 'candle', name: 'volatility', value: stdDev(returns), timeframe, source: 'candles', confidence: 0.8, metadata: { sampleSize: returns.length } }),
    createQuantFeature({ symbol, category: 'candle', name: 'candle_body_ratio', value: range > 0 ? body / range : 0, timeframe, source: 'candles', confidence: 0.9, metadata: { body, range } }),
    createQuantFeature({ symbol, category: 'candle', name: 'wick_ratio', value: range > 0 ? (upperWick + lowerWick) / range : 0, timeframe, source: 'candles', confidence: 0.9, metadata: { upperWick, lowerWick, range } }),
    createQuantFeature({ symbol, category: 'candle', name: 'range_expansion', value: priorAvgRange > 0 ? range / priorAvgRange : 0, timeframe, source: 'candles', confidence: 0.75, metadata: { latestRange: range, priorAvgRange } }),
    createQuantFeature({ symbol, category: 'candle', name: 'volume_z_score', value: volStd > 0 ? (latestVolume - volMean) / volStd : 0, timeframe, source: 'candles', confidence: 0.75, metadata: { latestVolume, volMean, volStd } }),
  ];
}

export function extractTrendFeatures(symbol, candles = [], timeframe = '1m') {
  if (!Array.isArray(candles) || candles.length < 3) return [];

  const closes = candles.map((c) => Number(c?.c) || 0);
  const volumes = candles.map((c) => Number(c?.v) || 0);
  const typicalPrices = candles.map((c) => ((Number(c?.h) || 0) + (Number(c?.l) || 0) + (Number(c?.c) || 0)) / 3);

  const shortEma = ema(closes, Math.min(5, closes.length));
  const longEma = ema(closes, Math.min(10, closes.length));
  const emaSlope = shortEma.length >= 2 ? shortEma[shortEma.length - 1] - shortEma[shortEma.length - 2] : 0;

  const pvSum = typicalPrices.reduce((acc, price, idx) => acc + (price * (volumes[idx] || 0)), 0);
  const vSum = volumes.reduce((acc, v) => acc + v, 0);
  const vwap = vSum > 0 ? pvSum / vSum : closes[closes.length - 1];

  const latestClose = closes[closes.length - 1] || 0;
  const vwapDistance = vwap !== 0 ? (latestClose - vwap) / vwap : 0;

  const momentumWindow = Math.min(5, closes.length - 1);
  const base = closes[closes.length - 1 - momentumWindow] || 0;
  const momentum = base !== 0 ? (latestClose - base) / base : 0;

  return [
    createQuantFeature({ symbol, category: 'trend', name: 'ema_slope', value: emaSlope, timeframe, source: 'candles', confidence: 0.7, metadata: { shortPeriod: Math.min(5, closes.length), longPeriod: Math.min(10, closes.length), latestShortEma: shortEma[shortEma.length - 1], latestLongEma: longEma[longEma.length - 1] } }),
    createQuantFeature({ symbol, category: 'trend', name: 'vwap_distance', value: vwapDistance, timeframe, source: 'candles', confidence: 0.8, metadata: { latestClose, vwap } }),
    createQuantFeature({ symbol, category: 'trend', name: 'momentum_score', value: momentum, timeframe, source: 'candles', confidence: 0.75, metadata: { momentumWindow } }),
  ];
}

export function extractOrderBookFeatures(symbol, book = null) {
  if (!book || typeof book !== 'object') return [];

  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  if (!bids.length || !asks.length) return [];

  const bidTop = bids[0] || {};
  const askTop = asks[0] || {};

  const bidPx = Number(bidTop.price) || 0;
  const askPx = Number(askTop.price) || 0;

  const sumSize = (levels) => levels.reduce((acc, lvl) => acc + (Number(lvl?.size) || 0), 0);
  const bidDepth = sumSize(bids);
  const askDepth = sumSize(asks);
  const totalDepth = bidDepth + askDepth;

  const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
  const mid = (bidPx + askPx) / 2;
  const spread = mid > 0 ? (askPx - bidPx) / mid : 0;

  const top3Bid = sumSize(bids.slice(0, 3));
  const top3Ask = sumSize(asks.slice(0, 3));
  const depthConcentration = totalDepth > 0 ? (top3Bid + top3Ask) / totalDepth : 0;
  const liquidityPressure = (Number(bidTop.size) || 0) - (Number(askTop.size) || 0);

  return [
    createQuantFeature({ symbol, category: 'orderbook', name: 'bid_ask_imbalance', value: imbalance, source: 'orderbook', confidence: 0.8, metadata: { bidDepth, askDepth } }),
    createQuantFeature({ symbol, category: 'orderbook', name: 'spread', value: spread, source: 'orderbook', confidence: 0.95, metadata: { bidPx, askPx } }),
    createQuantFeature({ symbol, category: 'orderbook', name: 'depth_concentration', value: depthConcentration, source: 'orderbook', confidence: 0.7, metadata: { top3Bid, top3Ask, totalDepth } }),
    createQuantFeature({ symbol, category: 'orderbook', name: 'liquidity_pressure', value: liquidityPressure, source: 'orderbook', confidence: 0.7, metadata: { topBidSize: Number(bidTop.size) || 0, topAskSize: Number(askTop.size) || 0 } }),
  ];
}

export function extractSignalFeatures(symbol, alphaSignals = [], patternSignals = [], strategies = [], timeframe = '1m') {
  const safeAlpha = Array.isArray(alphaSignals) ? alphaSignals : [];
  const safePatterns = Array.isArray(patternSignals) ? patternSignals : [];
  const safeStrategies = Array.isArray(strategies) ? strategies : [];

  const bullishAlpha = safeAlpha.filter((s) => s?.direction === 'bullish').length;
  const bearishAlpha = safeAlpha.filter((s) => s?.direction === 'bearish').length;
  const alphaRatio = bearishAlpha > 0 ? bullishAlpha / bearishAlpha : bullishAlpha > 0 ? bullishAlpha : 0;

  const bullishPattern = safePatterns.filter((s) => s?.direction === 'bullish').length;
  const bearishPattern = safePatterns.filter((s) => s?.direction === 'bearish').length;

  const alphaSkew = safeAlpha.length > 0 ? Math.abs(bullishAlpha - bearishAlpha) / safeAlpha.length : 0;
  const patternSkew = safePatterns.length > 0 ? Math.abs(bullishPattern - bearishPattern) / safePatterns.length : 0;
  const conflictScore = 1 - ((alphaSkew + patternSkew) / 2);

  return [
    createQuantFeature({ symbol, category: 'signal', name: 'alpha_count', value: safeAlpha.length, timeframe, source: 'signals', confidence: 0.9 }),
    createQuantFeature({ symbol, category: 'signal', name: 'bullish_bearish_alpha_ratio', value: alphaRatio, timeframe, source: 'signals', confidence: 0.8, metadata: { bullishAlpha, bearishAlpha } }),
    createQuantFeature({ symbol, category: 'signal', name: 'pattern_count', value: safePatterns.length, timeframe, source: 'signals', confidence: 0.9 }),
    createQuantFeature({ symbol, category: 'signal', name: 'strategy_candidate_count', value: safeStrategies.length, timeframe, source: 'signals', confidence: 0.9 }),
    createQuantFeature({ symbol, category: 'signal', name: 'signal_conflict_score', value: conflictScore, timeframe, source: 'signals', confidence: 0.7, metadata: { alphaSkew, patternSkew } }),
  ];
}
