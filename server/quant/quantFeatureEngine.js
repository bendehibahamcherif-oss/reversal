import { getCandles } from '../persistence/historicalStore.js';
import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { strategyEngine } from '../strategies/strategyEngine.js';
import {
  extractCandleFeatures,
  extractTrendFeatures,
  extractOrderBookFeatures,
  extractSignalFeatures,
} from './featureExtractors.js';

class QuantFeatureEngine {
  constructor() {
    this.featuresBySymbol = new Map();
  }

  extractForSymbol(symbol, timeframe = '1m', runtimeBook = null, candlesInput = null) {
    const normalized = String(symbol || '').toUpperCase();
    if (!normalized) return [];

    const candles = Array.isArray(candlesInput) ? candlesInput : getCandles(normalized, timeframe);
    const alphaSignals = alphaEngine.getSignals(normalized);
    const patternSignals = patternEngine.getPatterns(normalized);
    const strategies = strategyEngine.getStrategies(normalized);

    const features = [
      ...this.extractFromCandles(normalized, candles, timeframe),
      ...this.extractFromOrderBook(normalized, runtimeBook),
      ...this.extractFromSignals(normalized, alphaSignals, patternSignals, strategies, timeframe),
    ];

    this.featuresBySymbol.set(normalized, features);
    return features;
  }

  extractFromCandles(symbol, candles, timeframe = '1m') {
    return [
      ...extractCandleFeatures(symbol, candles, timeframe),
      ...extractTrendFeatures(symbol, candles, timeframe),
    ];
  }

  extractFromOrderBook(symbol, book) {
    return extractOrderBookFeatures(symbol, book);
  }

  extractFromSignals(symbol, alphaSignals, patternSignals, strategies, timeframe = '1m') {
    return extractSignalFeatures(symbol, alphaSignals, patternSignals, strategies, timeframe);
  }

  getFeatures(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    return this.featuresBySymbol.get(normalized) || [];
  }

  clearFeatures(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    this.featuresBySymbol.delete(normalized);
    return [];
  }
}

export const quantFeatureEngine = new QuantFeatureEngine();
