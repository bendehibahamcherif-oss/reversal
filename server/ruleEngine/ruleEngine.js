import { createStrategyRuleSet } from './strategyRuleSet.js';
import { createSavedStrategy } from '../strategyLab/savedStrategy.js';
import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { quantFeatureEngine } from '../quant/quantFeatureEngine.js';
import { qualityEngine } from '../quality/qualityEngine.js';
import { analysisTrendEngine } from '../analytics/analysisTrendEngine.js';
import { backtestEngine } from '../backtest/backtestEngine.js';
import { strategyEngine } from '../strategies/strategyEngine.js';

class RuleEngine {
  constructor() {
    this.ruleSets = [];
  }

  async createRuleSet(ruleSet) {
    const created = createStrategyRuleSet(ruleSet);
    this.ruleSets.unshift(created);
    return created;
  }

  async updateRuleSet(id, updates = {}) {
    const idx = this.ruleSets.findIndex((item) => item.id === String(id || ''));
    if (idx < 0) return null;
    const merged = createStrategyRuleSet({ ...this.ruleSets[idx], ...updates, id: this.ruleSets[idx].id, createdAt: this.ruleSets[idx].createdAt, updatedAt: new Date().toISOString() });
    this.ruleSets[idx] = merged;
    return merged;
  }

  async getRuleSets(symbol) {
    const s = String(symbol || '').toUpperCase();
    return this.ruleSets.filter((item) => !s || item.symbol === s).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRuleSetById(id) { return this.ruleSets.find((item) => item.id === String(id || '')) || null; }
  async deleteRuleSet(id) { const before = this.ruleSets.length; this.ruleSets = this.ruleSets.filter((item) => item.id !== String(id || '')); return { deleted: before - this.ruleSets.length }; }
  async clearRuleSets(symbol) { const s = String(symbol || '').toUpperCase(); const before = this.ruleSets.length; this.ruleSets = s ? this.ruleSets.filter((item) => item.symbol !== s) : []; return { deleted: before - this.ruleSets.length }; }

  async evaluateRuleSet(symbol, ruleSetId) {
    const normalized = String(symbol || '').toUpperCase();
    const ruleSet = await this.getRuleSetById(ruleSetId);
    if (!ruleSet) return null;
    const warnings = [];
    const ctx = await this.getContext(normalized);
    const matched = [];
    const failed = [];

    for (const condition of ruleSet.conditions.filter((c) => c.enabled !== false)) {
      const evaluation = this.evaluateCondition(condition, ctx);
      if (evaluation.warning) warnings.push(evaluation.warning);
      if (evaluation.passed) matched.push(evaluation); else failed.push(evaluation);
    }

    return { symbol: normalized, ruleSetId: ruleSet.id, matchedConditions: matched, failedConditions: failed, warnings, passed: failed.length === 0 };
  }

  async convertRuleSetToStrategy(symbol, ruleSetId) {
    const normalized = String(symbol || '').toUpperCase();
    const ruleSet = await this.getRuleSetById(ruleSetId);
    if (!ruleSet) return null;
    const firstAction = ruleSet.actions[0] || {};
    return createSavedStrategy({
      symbol: normalized || ruleSet.symbol,
      name: ruleSet.name,
      type: 'rule_engine',
      status: ruleSet.status === 'research_only' ? 'research_only' : 'draft',
      direction: firstAction.direction || 'neutral',
      timeframe: ruleSet.timeframe,
      entryLogic: firstAction.entryLogic || 'Rule-based entry. Review before any live usage.',
      exitLogic: firstAction.exitLogic || 'Rule-based exit. Review before any live usage.',
      riskRules: { ...ruleSet.riskRules, ...firstAction.riskRules },
      tags: [...ruleSet.tags, 'rule_engine'],
      notes: ruleSet.description,
      warnings: ['Converted from Rule Engine definition; draft/research only and not validated.'],
    });
  }

  async getContext(symbol) {
    return {
      alpha: alphaEngine.getSignals(symbol),
      pattern: patternEngine.getPatterns(symbol),
      quantFeature: quantFeatureEngine.getFeatures(symbol),
      qualityScore: qualityEngine.getQualityScores(symbol),
      analytics: await analysisTrendEngine.getLatestTrend(symbol),
      backtest: backtestEngine.getBacktestResults(symbol),
      strategy: strategyEngine.getStrategies(symbol),
    };
  }

  evaluateCondition(condition, ctx) {
    const sourceData = ctx[condition.source];
    if (sourceData === undefined || sourceData === null || (Array.isArray(sourceData) && sourceData.length === 0)) {
      return { conditionId: condition.id, passed: false, warning: `Missing source data for ${condition.source}`, source: condition.source, field: condition.field, operator: condition.operator, expectedValue: condition.value, actualValue: null };
    }

    const actual = this.resolveField(sourceData, condition.field);
    if (actual === undefined) {
      return { conditionId: condition.id, passed: false, warning: `Field not found: ${condition.source}.${condition.field}`, source: condition.source, field: condition.field, operator: condition.operator, expectedValue: condition.value, actualValue: null };
    }

    const passed = this.applyOperator(condition.operator, actual, condition.value);
    return { conditionId: condition.id, passed, source: condition.source, field: condition.field, operator: condition.operator, expectedValue: condition.value, actualValue: actual };
  }

  resolveField(sourceData, fieldPath) {
    const path = String(fieldPath || '').trim();
    if (!path) return sourceData;
    const root = Array.isArray(sourceData) ? sourceData[sourceData.length - 1] : sourceData;
    return path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), root);
  }

  applyOperator(operator, actual, expected) {
    switch (operator) {
      case '>': return Number(actual) > Number(expected);
      case '>=': return Number(actual) >= Number(expected);
      case '<': return Number(actual) < Number(expected);
      case '<=': return Number(actual) <= Number(expected);
      case '==': return actual === expected;
      case '!=': return actual !== expected;
      case 'contains': return Array.isArray(actual) ? actual.includes(expected) : String(actual).includes(String(expected));
      case 'exists': return actual !== undefined && actual !== null;
      default: return false;
    }
  }
}

export const ruleEngine = new RuleEngine();
