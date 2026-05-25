import { getCandles } from '../persistence/historicalStore.js';
import { detectCandlePatterns, detectVolatilityPatterns, detectOrderflowPatterns } from './detectors.js';

class PatternEngine {
  constructor() {
    this.patternsBySymbol = new Map();
  }

  append(symbol, patterns) {
    const normalized = String(symbol || '').toUpperCase();
    if (!normalized) return [];
    const existing = this.patternsBySymbol.get(normalized) || [];
    const merged = [...existing, ...(Array.isArray(patterns) ? patterns : [])].slice(-300);
    this.patternsBySymbol.set(normalized, merged);
    return merged;
  }

  analyzeCandles(symbol, timeframe = '1m', candlesInput = null) {
    const normalized = String(symbol || '').toUpperCase();
    const candles = Array.isArray(candlesInput) ? candlesInput : getCandles(normalized, timeframe);
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const patterns = [
      ...detectCandlePatterns(normalized, timeframe, candles),
      ...detectVolatilityPatterns(normalized, timeframe, candles),
    ];
    this.append(normalized, patterns);
    return patterns;
  }

  analyzeTick(symbol, tick = {}) {
    const normalized = String(symbol || '').toUpperCase();
    if (!tick || typeof tick !== 'object') return [];
    const book = tick.orderBook || tick.book || null;
    if (!book) return [];
    const patterns = detectOrderflowPatterns(normalized, book);
    this.append(normalized, patterns);
    return patterns;
  }

  analyzeOrderBook(symbol, book = null) {
    const normalized = String(symbol || '').toUpperCase();
    if (!book) return [];
    const patterns = detectOrderflowPatterns(normalized, book);
    this.append(normalized, patterns);
    return patterns;
  }

  getPatterns(symbol) {
    return this.patternsBySymbol.get(String(symbol || '').toUpperCase()) || [];
  }

  clearPatterns(symbol) {
    this.patternsBySymbol.delete(String(symbol || '').toUpperCase());
    return [];
  }
}

export const patternEngine = new PatternEngine();
