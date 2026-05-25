import { createAlphaSignal } from './alphaSignal.js';

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    result = values[i] * alpha + result * (1 - alpha);
  }
  return result;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function detectCandleAlphas(symbol, timeframe, candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return [];

  const closes = candles.map((c) => Number(c.c)).filter(Number.isFinite);
  const volumes = candles.map((c) => Number(c.v)).filter(Number.isFinite);
  if (!closes.length) return [];

  const latest = closes[closes.length - 1];
  const signals = [];

  const vwapNum = candles.reduce((acc, c) => acc + Number(c.c || 0) * Number(c.v || 0), 0);
  const vwapDen = candles.reduce((acc, c) => acc + Number(c.v || 0), 0);
  if (vwapDen > 0) {
    const vwap = vwapNum / vwapDen;
    const deviationPct = ((latest - vwap) / vwap) * 100;
    if (Math.abs(deviationPct) >= 0.2) {
      signals.push(createAlphaSignal({
        symbol,
        type: 'vwap-deviation',
        category: 'mean-reversion',
        direction: deviationPct > 0 ? 'bearish' : 'bullish',
        confidence: Math.min(0.95, Math.abs(deviationPct) / 2),
        strength: Math.min(1, Math.abs(deviationPct) / 3),
        timeframe,
        reason: `Price deviates ${deviationPct.toFixed(2)}% from VWAP`,
        features: { vwap, price: latest, deviationPct },
      }));
    }
  }

  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  if (fast && slow) {
    const spreadPct = ((fast - slow) / slow) * 100;
    if (Math.abs(spreadPct) >= 0.1) {
      signals.push(createAlphaSignal({
        symbol,
        type: 'ema-momentum',
        category: 'trend',
        direction: spreadPct > 0 ? 'bullish' : 'bearish',
        confidence: Math.min(0.95, Math.abs(spreadPct) / 1.5),
        strength: Math.min(1, Math.abs(spreadPct) / 2),
        timeframe,
        reason: `EMA(9/21) spread at ${spreadPct.toFixed(2)}%`,
        features: { emaFast: fast, emaSlow: slow, spreadPct },
      }));
    }
  }

  const rsiValue = rsi(closes, 14);
  if (Number.isFinite(rsiValue) && (rsiValue >= 70 || rsiValue <= 30)) {
    signals.push(createAlphaSignal({
      symbol,
      type: 'rsi-exhaustion',
      category: 'exhaustion',
      direction: rsiValue >= 70 ? 'bearish' : 'bullish',
      confidence: Math.min(0.95, Math.abs(50 - rsiValue) / 45),
      strength: Math.min(1, Math.abs(50 - rsiValue) / 50),
      timeframe,
      reason: `RSI indicates exhaustion at ${rsiValue.toFixed(2)}`,
      features: { rsi: rsiValue },
    }));
  }

  if (volumes.length >= 5) {
    const latestVolume = volumes[volumes.length - 1];
    const avgVol = volumes.slice(-5, -1).reduce((a, b) => a + b, 0) / 4;
    if (avgVol > 0) {
      const ratio = latestVolume / avgVol;
      if (ratio >= 1.5) {
        signals.push(createAlphaSignal({
          symbol,
          type: 'volume-spike',
          category: 'participation',
          direction: 'neutral',
          confidence: Math.min(0.95, ratio / 4),
          strength: Math.min(1, ratio / 5),
          timeframe,
          reason: `Volume spike at ${ratio.toFixed(2)}x recent average`,
          features: { latestVolume, avgVol, ratio },
        }));
      }
    }
  }

  return signals;
}

export function detectOrderBookAlphas(symbol, book) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return [];

  const bidSize = book.bids.reduce((acc, level) => acc + Number(level.size || level[1] || 0), 0);
  const askSize = book.asks.reduce((acc, level) => acc + Number(level.size || level[1] || 0), 0);
  const total = bidSize + askSize;
  if (total <= 0) return [];

  const imbalance = (bidSize - askSize) / total;
  if (Math.abs(imbalance) < 0.15) return [];

  return [createAlphaSignal({
    symbol,
    type: 'liquidity-imbalance',
    category: 'microstructure',
    direction: imbalance > 0 ? 'bullish' : 'bearish',
    confidence: Math.min(0.95, Math.abs(imbalance) * 2),
    strength: Math.min(1, Math.abs(imbalance) * 2.5),
    timeframe: 'tick',
    reason: `Order book imbalance at ${(imbalance * 100).toFixed(2)}%`,
    features: { bidSize, askSize, imbalance },
  })];
}
