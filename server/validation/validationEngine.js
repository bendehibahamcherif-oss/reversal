import { strategyEngine } from '../strategies/strategyEngine.js';
import { backtestEngine } from '../backtest/backtestEngine.js';
import { qualityEngine } from '../quality/qualityEngine.js';
import { createStrategyValidationResult } from './strategyValidationResult.js';

class StrategyValidationEngine {
  constructor() { this.resultsBySymbol = new Map(); }
  validateStrategy(symbol, strategyId) {
    const normalized = this.normalizeSymbol(symbol);
    const strategyCandidate = strategyEngine.getStrategies(normalized).find((s) => s.id === strategyId);
    if (!strategyCandidate) {
      return this.validateFromInputs(normalized, null, null, [], [strategyId ? `Strategy id ${strategyId} was not found for ${normalized}.` : `No strategy id provided for ${normalized}.`]);
    }
    const backtestResults = this.findBacktestResult(normalized, strategyCandidate.id) || backtestEngine.runBacktest(normalized, strategyCandidate.id);
    return this.validateFromInputs(normalized, strategyCandidate, backtestResults, qualityEngine.getQualityScores(normalized));
  }
  validateLatestStrategy(symbol) {
    const normalized = this.normalizeSymbol(symbol);
    const latest = strategyEngine.getStrategies(normalized).slice(-1)[0];
    if (!latest) return this.validateFromInputs(normalized, null, null, qualityEngine.getQualityScores(normalized), [`No strategy candidates found for ${normalized}.`]);
    return this.validateStrategy(normalized, latest.id);
  }
  validateFromInputs(symbol, strategyCandidate, backtestResults, qualityScores, initialWarnings = []) {
    const normalized = this.normalizeSymbol(symbol);
    const reasons = [];
    const warnings = Array.isArray(initialWarnings) ? [...initialWarnings] : [];
    const candidate = strategyCandidate && typeof strategyCandidate === 'object' ? strategyCandidate : null;
    const metrics = backtestResults?.metrics && typeof backtestResults.metrics === 'object' ? backtestResults.metrics : {};
    let score = this.normalizePercent(candidate?.confidence);
    reasons.push(`Base score from strategy confidence (${Math.round(score)}).`);

    const qualitySummary = this.buildQualitySummary(candidate, Array.isArray(qualityScores) ? qualityScores : []);
    if (qualitySummary.grade === 'A') { score += 12; reasons.push('Quality grade A bonus (+12).'); }
    else if (qualitySummary.grade === 'B') { score += 7; reasons.push('Quality grade B bonus (+7).'); }

    const pnl = Number(metrics.totalPnL || 0);
    if (pnl > 0) { score += 12; reasons.push('Positive backtest totalPnL bonus (+12).'); }
    else if (pnl < 0) { score -= 16; reasons.push('Negative backtest totalPnL penalty (-16).'); warnings.push('Backtest totalPnL is negative; profitability not validated.'); }

    const profitFactor = Number(metrics.profitFactor);
    if (Number.isFinite(profitFactor) && profitFactor > 1) { score += 9; reasons.push('Profit factor above 1 bonus (+9).'); }
    const winRatePct = (Number(metrics.winRate) || 0) * 100;
    if (winRatePct >= 50) { score += 8; reasons.push('Win rate at or above 50% bonus (+8).'); }
    if ((Number(metrics.maxDrawdown) || 0) <= -2) { score -= 12; reasons.push('High max drawdown penalty (-12).'); warnings.push('Backtest drawdown is elevated relative to simple safety threshold.'); }

    const confidence = Number(candidate?.confidence || 0);
    if (confidence < 0.35) { score -= 12; reasons.push('Low confidence penalty (-12).'); }
    const candidateStatus = String(candidate?.status || 'missing');
    if (candidateStatus === 'research_only' || candidateStatus === 'needs_confirmation') { score -= 18; reasons.push(`Status ${candidateStatus} penalty (-18).`); warnings.push(`Candidate status is ${candidateStatus}; not considered automatically validated.`); }
    if (!candidate) { score -= 20; reasons.push('Missing strategy candidate penalty (-20).'); warnings.push('Validation ran without a strategy candidate; results are incomplete.'); }

    const validationScore = Math.max(0, Math.min(100, Math.round(score)));
    const riskSummary = { maxDrawdown: Number(metrics.maxDrawdown || 0), profitFactor: Number.isFinite(profitFactor) ? profitFactor : null, winRate: Number(metrics.winRate || 0), totalPnL: pnl, confidence, strategyStatus: candidateStatus, acceptable: this.isBacktestAcceptable(metrics) };
    const status = this.mapStatus(validationScore, riskSummary.acceptable);
    if (status !== 'validated') warnings.push('Validation status indicates this candidate should not be treated as production-approved performance.');

    const result = createStrategyValidationResult({ symbol: normalized, strategyId: candidate?.id || '', strategyName: candidate?.name || 'Unknown Strategy', validationScore, grade: this.mapGrade(validationScore), status, reasons, warnings: Array.from(new Set(warnings)), backtestSummary: { resultId: backtestResults?.id || '', numberOfTrades: Number(metrics.numberOfTrades || 0), totalPnL: pnl, totalPnLPercent: Number(metrics.totalPnLPercent || 0), winRate: Number(metrics.winRate || 0), profitFactor: Number.isFinite(profitFactor) ? profitFactor : null, maxDrawdown: Number(metrics.maxDrawdown || 0) }, qualitySummary, riskSummary });
    this.saveResult(normalized, result);
    return result;
  }
  getValidationResults(symbol) { return this.resultsBySymbol.get(this.normalizeSymbol(symbol)) || []; }
  getValidationResultById(symbol, id) { return this.getValidationResults(symbol).find((r) => r.id === id) || null; }
  clearValidationResults(symbol) { this.resultsBySymbol.delete(this.normalizeSymbol(symbol)); return []; }
  saveResult(symbol, result) { this.resultsBySymbol.set(this.normalizeSymbol(symbol), [...this.getValidationResults(symbol), result]); }
  normalizeSymbol(symbol) { return String(symbol || '').toUpperCase(); }
  normalizePercent(fraction) { const n = Number(fraction || 0); if (!Number.isFinite(n)) return 0; return Math.max(0, Math.min(100, n > 1 ? n : n * 100)); }
  mapGrade(score) { if (score >= 80) return 'A'; if (score >= 65) return 'B'; if (score >= 50) return 'C'; if (score >= 35) return 'D'; return 'F'; }
  mapStatus(score, acceptable) { if (score >= 75 && acceptable) return 'validated'; if (score >= 60) return 'watchlist'; if (score >= 40) return 'weak'; return 'rejected'; }
  isBacktestAcceptable(metrics = {}) { return Number(metrics.totalPnL || 0) > 0 && Number(metrics.maxDrawdown || 0) > -2 && Number(metrics.profitFactor || 0) > 1 && Number(metrics.winRate || 0) >= 0.5; }
  findBacktestResult(symbol, strategyId) { const results = backtestEngine.getBacktestResults(symbol); return (strategyId ? results.find((r) => r.strategyId === strategyId) : results.slice(-1)[0]) || null; }
  buildQualitySummary(candidate, qualityScores = []) {
    const relevant = candidate?.id ? qualityScores.filter((q) => q.signalId === candidate.id || q.signalType === 'strategy') : qualityScores;
    const top = relevant.slice().sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0];
    return { scoreId: top?.id || '', score: Number(top?.score || 0), grade: String(top?.grade || 'F'), totalScores: relevant.length };
  }
}

export const strategyValidationEngine = new StrategyValidationEngine();
