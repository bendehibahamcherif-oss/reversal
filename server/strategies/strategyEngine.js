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
        status: 'validated',
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
        status: 'validated',
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

    const isStrongAlpha = (signal) => {
      const confidence = Number(signal?.confidence) || 0;
      const strength = Number(signal?.strength) || 0;
      return confidence >= 0.6 || strength >= 0.6;
    };

    const avgStrengthConfidence = (signals) => {
      if (!signals.length) return 0;
      const total = signals.reduce((acc, s) => {
        const confidence = Number(s?.confidence) || 0;
        const strength = Number(s?.strength) || 0;
        return acc + Math.max(confidence, strength);
      }, 0);
      return total / signals.length;
    };

    const buildProvisionalCandidate = (direction, alphaGroup) => {
      const strongAlpha = alphaGroup.filter(isStrongAlpha);
      if (!strongAlpha.length) return null;

      const baseConfidence = avgStrengthConfidence(strongAlpha);
      const confidence = Math.max(0.3, Math.min(0.85, baseConfidence * 0.7));
      const dominant = strongAlpha[0] || {};
      const alphaReason = dominant.reason || dominant.signal || dominant.name || 'strong alpha signal';
      const side = direction === 'long' ? 'bullish' : 'bearish';

      return createStrategyCandidate({
        symbol: normalized,
        name: `${side[0].toUpperCase()}${side.slice(1)} Provisional Alpha Candidate`,
        type: 'provisional',
        status: 'needs_confirmation',
        warning: 'Generated from alpha signal without pattern confirmation',
        direction,
        confidence,
        timeframe,
        entryLogic: `Provisional ${direction} entry based on alpha signal: ${alphaReason}. Await pattern confirmation before considering validation.`,
        exitLogic: 'Exit on stop loss breach, invalidation, or take-profit targets.',
        riskRules: {
          maxRiskPerTrade: 0.005,
          stopLossLogic: direction === 'long'
            ? 'Use a protective stop 1 ATR below entry or below the recent swing low, whichever is tighter.'
            : 'Use a protective stop 1 ATR above entry or above the recent swing high, whichever is tighter.',
          takeProfitLogic: 'Scale out conservatively at 1R and fully exit by 1.5R unless pattern confirmation appears.',
          invalidationCondition: `Invalidate if ${side} alpha weakens below threshold or opposite alpha dominates before confirmation.`,
        },
        supportingSignals: strongAlpha,
        warnings: ['Generated from alpha signal without pattern confirmation'],
      });
    };

    if (!hasBullishAlignment && bullishPatterns.length === 0) {
      const provisionalBullish = buildProvisionalCandidate('long', bullishAlpha);
      if (provisionalBullish) strategies.push(provisionalBullish);
    }

    if (!hasBearishAlignment && bearishPatterns.length === 0) {
      const provisionalBearish = buildProvisionalCandidate('short', bearishAlpha);
      if (provisionalBearish) strategies.push(provisionalBearish);
    }

    const findFeature = (key) => safePatterns.find((p) => p?.feature === key || p?.name === key || p?.type === key);
    const alphaCount = Number(findFeature('alpha_count')?.value);
    const patternCount = Number(findFeature('pattern_count')?.value);
    const signalConflictScoreRaw = findFeature('signal_conflict_score')?.value;
    const signalConflictScore = signalConflictScoreRaw === undefined ? null : Number(signalConflictScoreRaw);

    const hasQuantContext = Number.isFinite(alphaCount) && alphaCount > 0
      || Number.isFinite(patternCount) && patternCount > 0
      || signalConflictScoreRaw !== undefined;

    const hasAnyAlpha = safeAlpha.length > 0;

    if (!strategies.length && (hasQuantContext || hasAnyAlpha)) {
      const directionScore = safeAlpha.reduce((acc, signal) => {
        const weight = Math.max(Number(signal?.confidence) || 0, Number(signal?.strength) || 0, 0.05);
        if (signal?.direction === 'bullish') return acc + weight;
        if (signal?.direction === 'bearish') return acc - weight;
        return acc;
      }, 0);

      const direction = directionScore > 0.1 ? 'long' : directionScore < -0.1 ? 'short' : 'neutral';
      const contextBits = [
        Number.isFinite(alphaCount) ? `alpha_count=${alphaCount}` : null,
        Number.isFinite(patternCount) ? `pattern_count=${patternCount}` : null,
        signalConflictScoreRaw !== undefined ? `signal_conflict_score=${Number.isFinite(signalConflictScore) ? signalConflictScore : 'n/a'}` : null,
        `alpha_signals=${safeAlpha.length}`,
      ].filter(Boolean);

      const directionalText = direction === 'neutral'
        ? 'Enter only after confirmation signal; research candidate only.'
        : `Direction inferred from dominant alpha bias (${direction}); wait for confirmation trigger before live consideration.`;

      strategies.push(createStrategyCandidate({
        symbol: normalized,
        name: 'Research Test Candidate',
        type: 'test_candidate',
        status: 'research_only',
        warning: 'Generated for backtest research; not validated.',
        direction,
        confidence: 0.25,
        timeframe,
        entryLogic: `Research context: ${contextBits.join(', ')}. ${directionalText}`,
        exitLogic: 'Exit on stop loss breach, invalidation, or conservative take-profit targets.',
        riskRules: {
          maxRiskPerTrade: 0.003,
          stopLossLogic: direction === 'short'
            ? 'Use a protective stop above the recent swing high or 0.8 ATR above entry.'
            : 'Use a protective stop below the recent swing low or 0.8 ATR below entry.',
          takeProfitLogic: 'Take partial profits at 1R and fully exit by 1.25R unless stronger confirmation appears.',
          invalidationCondition: 'Invalidate if alpha/pattern context degrades or if opposite directional evidence becomes dominant.',
        },
        supportingSignals: [...safeAlpha, ...safePatterns],
        warnings: ['Generated for backtest research; not validated.'],
      }));
    }

    if (!strategies.length) return [];

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
