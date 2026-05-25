import { createPatternSignal } from './patternSignal.js';

function num(v) { return Number(v); }
function validCandle(c) {
  return c && [c.o, c.h, c.l, c.c].every((v) => Number.isFinite(num(v)));
}

function bodySize(c) { return Math.abs(num(c.c) - num(c.o)); }
function rangeSize(c) { return Math.max(0, num(c.h) - num(c.l)); }
function upperWick(c) { return Math.max(0, num(c.h) - Math.max(num(c.o), num(c.c))); }
function lowerWick(c) { return Math.max(0, Math.min(num(c.o), num(c.c)) - num(c.l)); }

export function detectCandlePatterns(symbol, timeframe, candles = []) {
  if (!Array.isArray(candles) || candles.length < 2) return [];
  const sanitized = candles.filter(validCandle);
  if (sanitized.length < 2) return [];

  const signals = [];
  const last = sanitized[sanitized.length - 1];
  const prev = sanitized[sanitized.length - 2];

  const prevBull = num(prev.c) > num(prev.o);
  const prevBear = num(prev.c) < num(prev.o);
  const lastBull = num(last.c) > num(last.o);
  const lastBear = num(last.c) < num(last.o);

  if (prevBear && lastBull && num(last.o) <= num(prev.c) && num(last.c) >= num(prev.o)) {
    signals.push(createPatternSignal({ symbol, pattern: 'bullish-engulfing', category: 'candle', direction: 'bullish', confidence: 0.78, timeframe, reason: 'Current bullish body engulfs prior bearish body.', features: { prevOpen: num(prev.o), prevClose: num(prev.c), open: num(last.o), close: num(last.c) } }));
  }

  if (prevBull && lastBear && num(last.o) >= num(prev.c) && num(last.c) <= num(prev.o)) {
    signals.push(createPatternSignal({ symbol, pattern: 'bearish-engulfing', category: 'candle', direction: 'bearish', confidence: 0.78, timeframe, reason: 'Current bearish body engulfs prior bullish body.', features: { prevOpen: num(prev.o), prevClose: num(prev.c), open: num(last.o), close: num(last.c) } }));
  }

  const lastRange = rangeSize(last);
  const lastBody = bodySize(last);
  if (lastRange > 0) {
    const lw = lowerWick(last);
    const uw = upperWick(last);
    if (lw >= lastBody * 2 && uw <= lastBody * 0.8) {
      signals.push(createPatternSignal({ symbol, pattern: 'pin-bar-hammer', category: 'candle', direction: 'bullish', confidence: 0.72, timeframe, reason: 'Long lower wick with small body suggests rejection of lower prices.', features: { body: lastBody, lowerWick: lw, upperWick: uw, range: lastRange } }));
    }
  }

  if (num(last.h) <= num(prev.h) && num(last.l) >= num(prev.l)) {
    signals.push(createPatternSignal({ symbol, pattern: 'inside-bar', category: 'candle', direction: 'neutral', confidence: 0.66, timeframe, reason: 'Latest candle is contained within prior candle range.', features: { prevHigh: num(prev.h), prevLow: num(prev.l), high: num(last.h), low: num(last.l) } }));
  }

  if (sanitized.length >= 5) {
    const recentRanges = sanitized.slice(-5, -1).map(rangeSize);
    const avgRecentRange = recentRanges.reduce((a, b) => a + b, 0) / recentRanges.length;
    const v = Number(last.v || 0);
    const avgVol = sanitized.slice(-5, -1).reduce((a, c) => a + Number(c.v || 0), 0) / 4;
    const closeNearLow = num(last.c) <= num(last.l) + lastRange * 0.2;
    const closeNearHigh = num(last.c) >= num(last.h) - lastRange * 0.2;
    if (avgRecentRange > 0 && lastRange >= avgRecentRange * 1.8 && avgVol > 0 && v >= avgVol * 1.5 && (closeNearLow || closeNearHigh)) {
      signals.push(createPatternSignal({ symbol, pattern: 'exhaustion-candle', category: 'candle', direction: closeNearHigh ? 'bullish' : 'bearish', confidence: 0.74, timeframe, reason: 'Large expansion candle with high volume and close near extreme.', features: { lastRange, avgRecentRange, volume: v, avgVolume: avgVol, closeNearHigh, closeNearLow } }));
    }
  }

  return signals;
}

export function detectVolatilityPatterns(symbol, timeframe, candles = []) {
  if (!Array.isArray(candles) || candles.length < 6) return [];
  const sanitized = candles.filter(validCandle);
  if (sanitized.length < 6) return [];
  const signals = [];
  const ranges = sanitized.map(rangeSize);
  const last = sanitized[sanitized.length - 1];
  const prev = sanitized[sanitized.length - 2];

  const base = ranges.slice(-6, -1);
  const baseAvg = base.reduce((a, b) => a + b, 0) / base.length;
  const lastRange = ranges[ranges.length - 1];
  const minBase = Math.min(...base);
  const maxBase = Math.max(...base);

  if (baseAvg > 0 && maxBase / baseAvg < 1.25 && minBase / baseAvg > 0.75) {
    signals.push(createPatternSignal({ symbol, pattern: 'volatility-compression', category: 'volatility', direction: 'neutral', confidence: 0.69, timeframe, reason: 'Recent candle ranges are tightly clustered.', features: { baseAvg, minBase, maxBase } }));
  }

  if (baseAvg > 0 && lastRange >= baseAvg * 1.8) {
    const direction = num(last.c) >= num(prev.c) ? 'bullish' : 'bearish';
    signals.push(createPatternSignal({ symbol, pattern: 'breakout-expansion', category: 'volatility', direction, confidence: 0.76, timeframe, reason: 'Latest range expanded materially versus recent baseline.', features: { lastRange, baseAvg, multiple: lastRange / baseAvg } }));
  }

  if (sanitized.length >= 8) {
    const recent = sanitized.slice(-8);
    const prior = recent.slice(0, 6);
    const breakout = recent[6];
    const confirm = recent[7];
    const priorHigh = Math.max(...prior.map((c) => num(c.h)));
    const priorLow = Math.min(...prior.map((c) => num(c.l)));
    const brokeUp = num(breakout.h) > priorHigh && num(confirm.c) < priorHigh;
    const brokeDown = num(breakout.l) < priorLow && num(confirm.c) > priorLow;
    if (brokeUp || brokeDown) {
      signals.push(createPatternSignal({ symbol, pattern: 'fake-breakout', category: 'volatility', direction: brokeUp ? 'bearish' : 'bullish', confidence: 0.71, timeframe, reason: 'Breakout beyond prior range failed to hold on follow-through candle.', features: { priorHigh, priorLow, breakoutHigh: num(breakout.h), breakoutLow: num(breakout.l), confirmClose: num(confirm.c) } }));
    }
  }

  return signals;
}

export function detectOrderflowPatterns(symbol, book = null) {
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks) || book.bids.length === 0 || book.asks.length === 0) return [];
  const signals = [];
  const bids = book.bids.map((l) => ({ price: Number(l.price ?? l[0]), size: Number(l.size ?? l[1]) })).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
  const asks = book.asks.map((l) => ({ price: Number(l.price ?? l[0]), size: Number(l.size ?? l[1]) })).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size));
  if (!bids.length || !asks.length) return [];

  const topBid = bids[0];
  const topAsk = asks[0];
  const spread = topAsk.price - topBid.price;
  const bidTotal = bids.reduce((a, b) => a + b.size, 0);
  const askTotal = asks.reduce((a, b) => a + b.size, 0);
  const avgBid = bidTotal / bids.length;
  const avgAsk = askTotal / asks.length;

  const bigBid = bids.find((l) => l.size >= avgBid * 2.5);
  const bigAsk = asks.find((l) => l.size >= avgAsk * 2.5);
  if (bigBid || bigAsk) {
    signals.push(createPatternSignal({ symbol, pattern: 'liquidity-sweep-candidate', category: 'orderflow', direction: bigBid ? 'bullish' : 'bearish', confidence: 0.64, timeframe: 'tick', reason: 'One side shows outsized resting liquidity versus ladder average.', features: { bigBid: bigBid || null, bigAsk: bigAsk || null, avgBid, avgAsk } }));
  }

  const imbalance = (bidTotal - askTotal) / (bidTotal + askTotal);
  if (Math.abs(imbalance) >= 0.25 && spread > 0) {
    signals.push(createPatternSignal({ symbol, pattern: 'absorption-candidate', category: 'orderflow', direction: imbalance > 0 ? 'bullish' : 'bearish', confidence: 0.67, timeframe: 'tick', reason: 'Persistent size imbalance can indicate passive absorption.', features: { bidTotal, askTotal, imbalance, spread } }));
  }

  const stackedBids = bids.slice(0, 3).every((l) => l.size >= avgBid * 1.4);
  const stackedAsks = asks.slice(0, 3).every((l) => l.size >= avgAsk * 1.4);
  if (stackedBids || stackedAsks) {
    signals.push(createPatternSignal({ symbol, pattern: 'imbalance-stack-candidate', category: 'orderflow', direction: stackedBids ? 'bullish' : 'bearish', confidence: 0.7, timeframe: 'tick', reason: 'Top ladder levels show stacked same-side size.', features: { stackedBids, stackedAsks, topBids: bids.slice(0, 3), topAsks: asks.slice(0, 3) } }));
  }

  return signals;
}
