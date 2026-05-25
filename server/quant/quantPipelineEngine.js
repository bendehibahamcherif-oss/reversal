import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { strategyEngine } from '../strategies/strategyEngine.js';
import { quantFeatureEngine } from './quantFeatureEngine.js';

class QuantPipelineEngine {
  runFullAnalysis(symbol, timeframe = '1m') {
    const normalized = String(symbol || '').toUpperCase();
    const safeTimeframe = String(timeframe || '1m');
    const warnings = [];

    if (!normalized) {
      warnings.push('No symbol provided; returning empty analysis.');
      return this.buildResponse({
        symbol: normalized,
        timeframe: safeTimeframe,
        alphaSignals: [],
        patternSignals: [],
        strategyCandidates: [],
        quantFeatures: [],
        warnings,
      });
    }

    const alphaSignals = this.safeArray(alphaEngine.analyzeCandles(normalized, safeTimeframe));
    if (alphaSignals.length === 0) {
      warnings.push('No alpha signals produced (market may be idle, closed, or data may be sparse).');
    }

    const patternSignals = this.safeArray(patternEngine.analyzeCandles(normalized, safeTimeframe));
    if (patternSignals.length === 0) {
      warnings.push('No pattern signals produced (market may be idle, closed, or data may be sparse).');
    }

    const strategyCandidates = this.safeArray(strategyEngine.generateForSymbol(normalized, safeTimeframe));
    if (strategyCandidates.length === 0) {
      warnings.push('No strategy candidates generated from current alpha/pattern alignment.');
    }

    const quantFeatures = this.safeArray(quantFeatureEngine.extractForSymbol(normalized, safeTimeframe));
    if (quantFeatures.length === 0) {
      warnings.push('No quant features extracted for current market state.');
    }

    return this.buildResponse({
      symbol: normalized,
      timeframe: safeTimeframe,
      alphaSignals,
      patternSignals,
      strategyCandidates,
      quantFeatures,
      warnings,
    });
  }

  safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  buildResponse({
    symbol,
    timeframe,
    alphaSignals,
    patternSignals,
    strategyCandidates,
    quantFeatures,
    warnings,
  }) {
    return {
      success: true,
      symbol,
      timeframe,
      alphaSignals,
      patternSignals,
      strategyCandidates,
      quantFeatures,
      warnings: this.safeArray(warnings),
      analyzedAt: new Date().toISOString(),
    };
  }
}

export const quantPipelineEngine = new QuantPipelineEngine();
