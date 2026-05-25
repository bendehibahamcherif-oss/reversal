import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { createStrategyCandidate } from './strategyCandidate.js';

class StrategyEngine {
  constructor() {
    this.strategiesBySymbol = new Map();
  }

  generateForSymbol(symbol, timeframe = '1m') {
    const normalized = String(symbol || '').toUpperCase();
    const alphaSignals = alphaEngine.getSignals(normalized);
    const patternSignals = patternEngine.getPatterns(normalized);
    const strategies = this.generateFromSignals(normalized, alphaSignals, patternSignals, timeframe);
    this.strategiesBySymbol.set(normalized, strategies);
    return strategies;
  }

  generateFromSignals(symbol, alphaSignals = [], patternSignals = [], timeframe = '1m') {
    const normalized = String(symbol || '').toUpperCase();
    const safeAlpha = Array.isArray(alphaSignals) ? alphaSignals : [];
    const safePatterns = Array.isArray(patternSignals) ? patternSignals : [];

    const bullishAlpha = safeAlpha.filter((s) => s?.direction === 'bullish');
    const bearishAlpha = safeAlpha.filter((s) => s?.direction === 'bearish');
    const bullishPatterns = safePatterns.filter((s) => s?.direction === 'bullish');
    const bearishPatterns = safePatterns.filter((s) => s?.direction === 'bearish');

    const hasBullishAlignment = bullishAlpha.length > 0 && bullishPatterns.length > 0;
    const hasBearishAlignment = bearishAlpha.length > 0 && bearishPatterns.length > 0;

    if (!hasBullishAlignment && !hasBearishAlignment) {
      return [];
    }

    const conflictingSignals = (bullishAlpha.length > 0 && bearishPatterns.length > 0)
      || (bearishAlpha.length > 0 && bullishPatterns.length > 0)
      || (hasBullishAlignment && hasBearishAlignment);

    const buildRiskRules = (direction) => ({
      maxRiskPerTrade: 0.01,
      stopLossLogic: direction === 'long'
        ? 'Exit if price closes below recent swing low or 1 ATR below entry.'
        : 'Exit if price closes above recent swing high or 1 ATR above entry.',
      takeProfitLogic: 'Scale out at 1R and target 2R on remaining size.',
      invalidationCondition: direction === 'long'
        ? 'Invalidate if bullish alpha-pattern alignment no longer exists.'
        : 'Invalidate if bearish alpha-pattern alignment no longer exists.',
    });

    const avgConfidence = (signals) => {
      if (!signals.length) return 0;
      const total = signals.reduce((acc, s) => acc + (Number(s?.confidence) || 0), 0);
      return total / signals.length;
    };

    const strategies = [];

    if (hasBullishAlignment) {
      const support = [...bullishAlpha, ...bullishPatterns];
      let confidence = (avgConfidence(bullishAlpha) + avgConfidence(bullishPatterns)) / 2;
      const warnings = [];
      if (conflictingSignals) {
        warnings.push('Conflicting bearish signals detected; confidence reduced.');
        confidence = Math.max(0, confidence - 0.2);
      }

      strategies.push(createStrategyCandidate({
        symbol: normalized,
        name: 'Bullish Alpha-Pattern Alignment',
        type: 'alignment',
        direction: 'long',
        confidence,
        timeframe,
        entryLogic: 'Enter long when bullish alpha and bullish pattern signals remain aligned.',
        exitLogic: 'Exit on stop loss breach, invalidation, or take-profit targets.',
        riskRules: buildRiskRules('long'),
        supportingSignals: support,
        warnings,
      }));
    }

    if (hasBearishAlignment) {
      const support = [...bearishAlpha, ...bearishPatterns];
      let confidence = (avgConfidence(bearishAlpha) + avgConfidence(bearishPatterns)) / 2;
      const warnings = [];
      if (conflictingSignals) {
        warnings.push('Conflicting bullish signals detected; confidence reduced.');
        confidence = Math.max(0, confidence - 0.2);
      }

      strategies.push(createStrategyCandidate({
        symbol: normalized,
        name: 'Bearish Alpha-Pattern Alignment',
        type: 'alignment',
        direction: 'short',
        confidence,
        timeframe,
        entryLogic: 'Enter short when bearish alpha and bearish pattern signals remain aligned.',
        exitLogic: 'Exit on stop loss breach, invalidation, or take-profit targets.',
        riskRules: buildRiskRules('short'),
        supportingSignals: support,
        warnings,
      }));
    }

    return strategies;
  }

  getStrategies(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    return this.strategiesBySymbol.get(normalized) || [];
  }

  clearStrategies(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    this.strategiesBySymbol.delete(normalized);
    return [];
  }
}

export const strategyEngine = new StrategyEngine();
