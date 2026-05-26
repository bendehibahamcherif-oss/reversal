import { strategyEngine } from '../strategies/strategyEngine.js';
import { createSavedStrategy } from './savedStrategy.js';
import { strategyLabStore } from './strategyLabStore.js';

class StrategyLabEngine {
  async saveFromCandidate(symbol, candidateId) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const sourceId = String(candidateId || '');

    const candidates = strategyEngine.getStrategies(normalizedSymbol);
    const candidate = candidates.find((item) => String(item?.id || '') === sourceId);
    if (!candidate) return null;

    const saved = createSavedStrategy({
      ...candidate,
      id: undefined,
      symbol: normalizedSymbol,
      status: 'needs_validation',
      sourceCandidateId: sourceId,
      notes: 'Saved from strategy candidate. Validation required before approval.',
    });

    return strategyLabStore.saveStrategy(saved);
  }

  async saveManualStrategy(strategy) {
    const manualStatus = String(strategy?.status || '').toLowerCase();
    const saved = createSavedStrategy({
      ...strategy,
      status: manualStatus === 'research_only' ? 'research_only' : 'draft',
    });
    return strategyLabStore.saveStrategy(saved);
  }

  async attachBacktestResult(strategyId, backtestResult = {}) {
    const strategy = await strategyLabStore.getStrategyById(strategyId);
    if (!strategy) return null;

    const nextBacktests = [...(strategy.backtestResults || []), {
      ...backtestResult,
      attachedAt: new Date().toISOString(),
    }];

    return strategyLabStore.updateStrategy(strategy.id, {
      backtestResults: nextBacktests,
      warnings: [...(strategy.warnings || []), ...(Array.isArray(backtestResult.warnings) ? backtestResult.warnings : [])],
    });
  }

  meetsValidationCriteria(validationResult = {}) {
    const status = String(validationResult.status || '').toLowerCase();
    const score = Number(validationResult.validationScore);
    return ['approved', 'validated', 'pass', 'passed'].includes(status) && Number.isFinite(score) && score >= 70;
  }

  async attachValidationResult(strategyId, validationResult = {}) {
    const strategy = await strategyLabStore.getStrategyById(strategyId);
    if (!strategy) return null;

    const approved = this.meetsValidationCriteria(validationResult);
    const nextStatus = approved ? 'validated' : 'needs_validation';
    const nextNotes = approved
      ? strategy.notes
      : `${strategy.notes ? `${strategy.notes}\n` : ''}Latest validation did not meet approval criteria.`;

    const nextValidation = [...(strategy.validationResults || []), {
      ...validationResult,
      attachedAt: new Date().toISOString(),
      criteriaMet: approved,
    }];

    return strategyLabStore.updateStrategy(strategy.id, {
      status: nextStatus,
      notes: nextNotes,
      validationResults: nextValidation,
      warnings: approved
        ? strategy.warnings || []
        : [...(strategy.warnings || []), 'Validation criteria not met; strategy remains unvalidated.'],
    });
  }

  async compareStrategies(symbol, strategyIds = []) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const all = await strategyLabStore.getStrategies(normalizedSymbol);
    const filtered = Array.isArray(strategyIds) && strategyIds.length
      ? all.filter((item) => strategyIds.includes(item.id))
      : all;

    const summaries = filtered.map((strategy) => {
      const latestBacktest = (strategy.backtestResults || []).at(-1) || null;
      const latestValidation = (strategy.validationResults || []).at(-1) || null;

      return {
        id: strategy.id,
        name: strategy.name,
        status: strategy.status,
        direction: strategy.direction,
        confidence: strategy.confidence,
        timeframe: strategy.timeframe,
        latestBacktest,
        latestValidation,
        warnings: strategy.warnings || [],
        tags: strategy.tags || [],
      };
    });

    return {
      symbol: normalizedSymbol,
      count: summaries.length,
      strategies: summaries,
    };
  }
}

export const strategyLabEngine = new StrategyLabEngine();
