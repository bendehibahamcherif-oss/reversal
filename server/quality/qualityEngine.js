import { createSignalQualityScore } from './signalQualityScore.js';

class QualityEngine {
  constructor() {
    this.scoresBySymbol = new Map();
  }

  scoreSignals(symbol, alphaSignals = [], patternSignals = [], strategies = [], quantFeatures = []) {
    const normalized = String(symbol || '').toUpperCase();
    const safeAlpha = this.safeArray(alphaSignals);
    const safePatterns = this.safeArray(patternSignals);
    const safeStrategies = this.safeArray(strategies);
    const safeFeatures = this.safeArray(quantFeatures);

    const allSignals = [
      ...safeAlpha.map((s) => ({ ...s, signalType: 'alpha' })),
      ...safePatterns.map((s) => ({ ...s, signalType: 'pattern' })),
      ...safeStrategies.map((s) => ({ ...s, signalType: 'strategy' })),
    ];

    if (!normalized || allSignals.length === 0) {
      this.scoresBySymbol.set(normalized, []);
      return [];
    }

    const scored = allSignals.map((signal) => this.scoreOneSignal(normalized, signal, allSignals, safeFeatures));
    this.scoresBySymbol.set(normalized, scored);
    return scored;
  }

  scoreOneSignal(symbol, signal, allSignals, quantFeatures) {
    const reasons = [];
    const bonuses = [];
    const penalties = [];
    const confidence = this.normalizeFraction(signal.confidence);
    const strength = this.normalizeFraction(signal.strength);

    let score = confidence * 100;
    reasons.push(`Base score from confidence (${Math.round(confidence * 100)}).`);

    if (strength >= 0.7) {
      score += 10;
      bonuses.push('Strong signal strength bonus (+10).');
    } else if (strength >= 0.5) {
      score += 5;
      bonuses.push('Moderate signal strength bonus (+5).');
    }

    if (this.hasAlignmentBonus(signal, allSignals)) {
      score += 8;
      bonuses.push('Alpha/pattern direction alignment bonus (+8).');
    }

    const featureSupportBonus = this.computeFeatureSupportBonus(signal, quantFeatures);
    if (featureSupportBonus > 0) {
      score += featureSupportBonus;
      bonuses.push(`Quant feature support bonus (+${featureSupportBonus}).`);
    }

    const conflicts = this.countConflicts(signal, allSignals);
    if (conflicts > 0) {
      const conflictPenalty = Math.min(15, conflicts * 5);
      score -= conflictPenalty;
      penalties.push(`Conflicting signals penalty (-${conflictPenalty}).`);
    }

    const stalePenalty = this.computeStalePenalty(signal.createdAt);
    if (stalePenalty > 0) {
      score -= stalePenalty;
      penalties.push(`Stale signal penalty (-${stalePenalty}).`);
    }

    if (confidence < 0.35) {
      score -= 12;
      penalties.push('Weak confidence penalty (-12).');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    reasons.push(...bonuses, ...penalties);

    return createSignalQualityScore({
      symbol,
      signalId: signal.id,
      signalType: signal.signalType,
      score,
      grade: this.mapGrade(score),
      reasons,
      penalties,
      bonuses,
    });
  }

  rankSignals(symbol) {
    return this.getQualityScores(symbol)
      .slice()
      .sort((a, b) => b.score - a.score || a.createdAt.localeCompare(b.createdAt));
  }

  filterSignals(symbol, minScore = 0) {
    const threshold = Number(minScore || 0);
    return this.rankSignals(symbol).filter((entry) => entry.score >= threshold);
  }

  getQualityScores(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    return this.safeArray(this.scoresBySymbol.get(normalized));
  }

  clearQualityScores(symbol) {
    const normalized = String(symbol || '').toUpperCase();
    this.scoresBySymbol.delete(normalized);
  }

  mapGrade(score) {
    if (score >= 80) return 'A';
    if (score >= 65) return 'B';
    if (score >= 50) return 'C';
    if (score >= 35) return 'D';
    return 'F';
  }

  hasAlignmentBonus(signal, allSignals) {
    const signalDirection = this.normalizeDirection(signal.direction);
    if (signalDirection === 'neutral') return false;

    const hasAlphaMatch = allSignals.some((item) => item.signalType === 'alpha' && this.normalizeDirection(item.direction) === signalDirection);
    const hasPatternMatch = allSignals.some((item) => item.signalType === 'pattern' && this.normalizeDirection(item.direction) === signalDirection);
    return hasAlphaMatch && hasPatternMatch;
  }

  countConflicts(signal, allSignals) {
    const signalDirection = this.normalizeDirection(signal.direction);
    if (signalDirection === 'neutral') return 0;

    const opposite = signalDirection === 'bullish' ? 'bearish' : 'bullish';
    return allSignals.filter((item) => item.id !== signal.id && this.normalizeDirection(item.direction) === opposite).length;
  }

  computeFeatureSupportBonus(signal, quantFeatures) {
    const featureCount = quantFeatures.length;
    if (featureCount === 0) return 0;

    const directionalFeatures = quantFeatures.filter((feature) => {
      const label = `${feature.name || ''} ${feature.type || ''} ${feature.reason || ''}`.toLowerCase();
      const signalDirection = this.normalizeDirection(signal.direction);
      if (signalDirection === 'bullish') return label.includes('bull') || label.includes('up');
      if (signalDirection === 'bearish') return label.includes('bear') || label.includes('down');
      return false;
    }).length;

    if (directionalFeatures >= 2) return 8;
    if (directionalFeatures >= 1) return 4;
    if (featureCount >= 3) return 2;
    return 0;
  }

  computeStalePenalty(createdAt) {
    const createdMs = Date.parse(createdAt || '');
    if (!Number.isFinite(createdMs)) return 4;
    const ageMinutes = (Date.now() - createdMs) / 60000;
    if (ageMinutes > 180) return 10;
    if (ageMinutes > 60) return 6;
    if (ageMinutes > 20) return 3;
    return 0;
  }

  normalizeDirection(direction) {
    const value = String(direction || '').toLowerCase();
    if (value === 'long') return 'bullish';
    if (value === 'short') return 'bearish';
    if (value === 'bullish' || value === 'bearish') return value;
    return 'neutral';
  }

  normalizeFraction(value) {
    const numeric = Number(value || 0);
    if (!Number.isFinite(numeric)) return 0;
    if (numeric > 1) return Math.max(0, Math.min(1, numeric / 100));
    return Math.max(0, Math.min(1, numeric));
  }

  safeArray(value) {
    return Array.isArray(value) ? value : [];
  }
}

export const qualityEngine = new QualityEngine();
