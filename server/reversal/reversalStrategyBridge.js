import { reversalDetectorEngine } from './reversalDetectorEngine.js';
import { strategyLabEngine } from '../strategyLab/strategyLabEngine.js';

class ReversalStrategyBridge {
  getReversalPoint(symbol = 'SPY', reversalPointId = '') {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const sourceId = String(reversalPointId || '');
    const reversalPoints = reversalDetectorEngine.getReversalPoints(normalizedSymbol);
    const reversalPoint = reversalPoints.find((point) => String(point?.id || '') === sourceId) || null;

    return {
      symbol: normalizedSymbol,
      reversalPoint,
      warnings: reversalPoint ? [] : [`Reversal point not found for symbol ${normalizedSymbol} and id ${sourceId}.`],
    };
  }

  createCandidateFromReversal(symbol = 'SPY', reversalPoint = {}) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    if (!reversalPoint || typeof reversalPoint !== 'object') {
      return {
        success: false,
        symbol: normalizedSymbol,
        strategy: null,
        warnings: ['Cannot create strategy candidate: reversal point payload is missing or invalid.'],
      };
    }

    const reversalWarnings = Array.isArray(reversalPoint.warnings) ? reversalPoint.warnings : [];
    const boundedScore = Math.max(0, Math.min(75, Number(reversalPoint.score) || 0));

    const strategy = {
      symbol: normalizedSymbol,
      name: `Reversal Strategy - ${String(reversalPoint.direction || 'neutral')}`,
      type: 'reversal_point',
      status: 'research_only',
      direction: reversalPoint.direction || 'neutral',
      timeframe: reversalPoint.timeframe || '1m',
      confidence: Math.round((boundedScore / 100) * 100) / 100,
      sourceReversalPointId: String(reversalPoint.id || ''),
      entryLogic: String(reversalPoint.entrySuggestion || ''),
      exitLogic: String(reversalPoint.targetSuggestion || ''),
      stopLossLogic: String(reversalPoint.stopSuggestion || ''),
      invalidationCondition: String(reversalPoint.invalidationCondition || ''),
      supportingSignals: Array.isArray(reversalPoint.supportingSignals) ? reversalPoint.supportingSignals : [],
      warnings: [
        'Generated from potential reversal point; not validated.',
        ...reversalWarnings,
      ],
      notes: 'Research-only strategy derived from a detected potential reversal point. Not validated.',
      tags: ['reversal', 'research_only'],
      riskRules: {
        stopLossLogic: String(reversalPoint.stopSuggestion || ''),
        invalidationCondition: String(reversalPoint.invalidationCondition || ''),
      },
    };

    return {
      success: true,
      symbol: normalizedSymbol,
      strategy,
      warnings: strategy.warnings,
    };
  }

  createStrategyFromReversal(symbol = 'SPY', reversalPointId = '') {
    const { symbol: normalizedSymbol, reversalPoint, warnings } = this.getReversalPoint(symbol, reversalPointId);
    if (!reversalPoint) {
      return {
        success: false,
        symbol: normalizedSymbol,
        strategy: null,
        savedStrategy: null,
        warnings,
      };
    }

    const created = this.createCandidateFromReversal(normalizedSymbol, reversalPoint);
    return {
      ...created,
      savedStrategy: null,
    };
  }

  async saveReversalStrategy(symbol = 'SPY', reversalPointId = '') {
    const created = this.createStrategyFromReversal(symbol, reversalPointId);
    if (!created.success || !created.strategy) {
      return created;
    }

    const savedStrategy = await strategyLabEngine.saveManualStrategy({
      ...created.strategy,
      status: 'research_only',
    });

    if (!savedStrategy) {
      return {
        ...created,
        success: false,
        savedStrategy: null,
        warnings: [...(created.warnings || []), 'Unable to save reversal-derived strategy in Strategy Lab.'],
      };
    }

    return {
      ...created,
      savedStrategy,
      warnings: savedStrategy.warnings || created.warnings || [],
    };
  }
}

export const reversalStrategyBridge = new ReversalStrategyBridge();
