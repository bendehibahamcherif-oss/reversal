import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { strategyEngine } from '../strategies/strategyEngine.js';
import { quantFeatureEngine } from './quantFeatureEngine.js';
import { qualityEngine } from '../quality/qualityEngine.js';
import { getCandlesWithMeta, FALLBACK_REASON } from '../persistence/historicalStore.js';

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
        qualityScores: [],
        rankedSignals: [],
        warnings,
        dataSource: 'unknown',
        isFallbackDemo: false,
      });
    }

    const candleData = getCandlesWithMeta(normalized, safeTimeframe);
    const candles = this.safeArray(candleData?.candles);
    if (candleData?.isFallbackDemo) {
      warnings.push(FALLBACK_REASON);
    }

    const alphaSignals = this.safeArray(alphaEngine.analyzeCandles(normalized, safeTimeframe, candles));
    if (alphaSignals.length === 0) {
      warnings.push('No alpha signals produced (market may be idle, closed, or data may be sparse).');
    }

    const patternSignals = this.safeArray(patternEngine.analyzeCandles(normalized, safeTimeframe, candles));
    if (patternSignals.length === 0) {
      warnings.push('No pattern signals produced (market may be idle, closed, or data may be sparse).');
    }

    const strategyCandidates = this.safeArray(strategyEngine.generateForSymbol(normalized, safeTimeframe));
    if (strategyCandidates.length === 0) {
      warnings.push('No strategy candidates generated from current alpha/pattern alignment.');
    }

    const quantFeatures = this.safeArray(quantFeatureEngine.extractForSymbol(normalized, safeTimeframe, null, candles));
    if (quantFeatures.length === 0) {
      warnings.push('No quant features extracted for current market state.');
    }

    const qualityScores = this.safeArray(
      qualityEngine.scoreSignals(normalized, alphaSignals, patternSignals, strategyCandidates, quantFeatures),
    );
    const rankedSignals = this.safeArray(qualityEngine.rankSignals(normalized));

    return this.buildResponse({
      symbol: normalized,
      timeframe: safeTimeframe,
      alphaSignals,
      patternSignals,
      strategyCandidates,
      quantFeatures,
      qualityScores,
      rankedSignals,
      warnings,
      dataSource: candleData?.source || 'unknown',
      isFallbackDemo: Boolean(candleData?.isFallbackDemo),
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
    qualityScores,
    rankedSignals,
    warnings,
    dataSource,
    isFallbackDemo,
  }) {
    return {
      success: true,
      symbol,
      timeframe,
      alphaSignals,
      patternSignals,
      strategyCandidates,
      quantFeatures,
      qualityScores: this.safeArray(qualityScores),
      rankedSignals: this.safeArray(rankedSignals),
      warnings: this.safeArray(warnings),
      dataSource: dataSource || 'unknown',
      isFallbackDemo: Boolean(isFallbackDemo),
      analyzedAt: new Date().toISOString(),
    };
  }
}

export const quantPipelineEngine = new QuantPipelineEngine();
