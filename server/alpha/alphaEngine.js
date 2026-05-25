import { getCandles } from '../persistence/historicalStore.js';
import { detectCandleAlphas, detectOrderBookAlphas } from './detectors.js';

class AlphaEngine {
  constructor() {
    this.signalsBySymbol = new Map();
  }

  appendSignals(symbol, signals) {
    const normalized = String(symbol || '').toUpperCase();
    if (!normalized) return [];
    const existing = this.signalsBySymbol.get(normalized) || [];
    const merged = [...existing, ...(Array.isArray(signals) ? signals : [])].slice(-200);
    this.signalsBySymbol.set(normalized, merged);
    return merged;
  }

  analyzeCandles(symbol, timeframe = '1m', candlesInput = null) {
    const normalized = String(symbol || '').toUpperCase();
    const candles = Array.isArray(candlesInput) ? candlesInput : getCandles(normalized, timeframe);
    const signals = detectCandleAlphas(normalized, timeframe, candles);
    this.appendSignals(normalized, signals);
    return signals;
  }

  analyzeTick(symbol, tick = {}) {
    const normalized = String(symbol || '').toUpperCase();
    if (!tick || typeof tick !== 'object') return [];
    const book = tick.orderBook || tick.book || null;
    if (!book) return [];
    const signals = detectOrderBookAlphas(normalized, book);
    this.appendSignals(normalized, signals);
    return signals;
  }

  analyzeOrderBook(symbol, book = null) {
    const normalized = String(symbol || '').toUpperCase();
    const signals = detectOrderBookAlphas(normalized, book);
    this.appendSignals(normalized, signals);
    return signals;
  }

  getSignals(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    return this.signalsBySymbol.get(normalized) || [];
  }

  clearSignals(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    this.signalsBySymbol.delete(normalized);
    return [];
  }
}

export const alphaEngine = new AlphaEngine();
