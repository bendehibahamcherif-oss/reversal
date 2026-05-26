import { sessionContextEngine } from '../sessionContext/sessionContextEngine.js';
import { alphaEngine } from '../alpha/alphaEngine.js';
import { patternEngine } from '../patterns/patternEngine.js';
import { quantFeatureEngine } from '../quant/quantFeatureEngine.js';
import { qualityEngine } from '../quality/qualityEngine.js';
import { getCandles } from '../persistence/historicalStore.js';
import { createReversalPoint } from './reversalPointModel.js';

class ReversalDetectorEngine {
  constructor() { this.pointsBySymbol = new Map(); }
  detectReversals(symbol = 'SPY', timeframe = '1m') {
    const s = String(symbol || 'SPY').toUpperCase();
    let context = sessionContextEngine.getLatestContext(s);
    if (!context) context = sessionContextEngine.computeSessionContext(s, timeframe);
    const alphaSignals = alphaEngine.getSignals(s);
    const patternSignals = patternEngine.getPatterns(s);
    const quantFeatures = quantFeatureEngine.getFeatures(s);
    const qualityScores = qualityEngine.getQualityScores(s);
    const reversalPoints = [...this.detectFromSessionContext(s, context, timeframe), ...this.detectFromSignals(s, alphaSignals, patternSignals, quantFeatures, qualityScores, context, timeframe)];
    const deduped = this.dedupe(reversalPoints);
    this.pointsBySymbol.set(s, deduped);
    const warnings = [...(context?.warnings || [])];
    if (deduped.length === 0) warnings.push('No reversal candidates met deterministic threshold in current inputs.');
    return { symbol: s, timeframe, reversalPoints: deduped, warnings };
  }
  detectFromSessionContext(symbol, context = {}, timeframe = '1m') {
    const out = []; const gap = context?.gapDirection || 'flat'; const vwapDistance = Number(context?.vwapDistance || 0);
    const price = this.latestPrice(symbol, timeframe);
    if (gap === 'up' && (vwapDistance < 0 || this.near(price, Number(context?.openingRangeHigh || 0)))) out.push(this.build(symbol, timeframe, 'short', 56, ['Gap-up context with VWAP rejection or opening range high failure.'], ['sessionContext'], [], context));
    if (gap === 'down' && (vwapDistance > 0 || this.near(price, Number(context?.openingRangeLow || 0)))) out.push(this.build(symbol, timeframe, 'long', 56, ['Gap-down context with VWAP rejection or opening range low failure.'], ['sessionContext'], [], context));
    return out;
  }
  detectFromSignals(symbol, alphaSignals = [], patternSignals = [], quantFeatures = [], qualityScores = [], context = {}, timeframe = '1m') {
    const gap = context?.gapDirection || 'flat'; const out = [];
    const bull = [...alphaSignals, ...patternSignals].filter((x) => this.norm(x?.direction) === 'bullish');
    const bear = [...alphaSignals, ...patternSignals].filter((x) => this.norm(x?.direction) === 'bearish');
    if (gap === 'up' && bear.length > 0) out.push(this.build(symbol, timeframe, 'short', 60, [`${bear.length} bearish alpha/pattern signals align after gap-up context.`], bear.map((s) => s.id).filter(Boolean), bull.length > 0 ? [`Detected ${bull.length} conflicting bullish signals.`] : [], context, quantFeatures, qualityScores));
    if (gap === 'down' && bull.length > 0) out.push(this.build(symbol, timeframe, 'long', 60, [`${bull.length} bullish alpha/pattern signals align after gap-down context.`], bull.map((s) => s.id).filter(Boolean), bear.length > 0 ? [`Detected ${bear.length} conflicting bearish signals.`] : [], context, quantFeatures, qualityScores));
    return out;
  }
  scoreReversal(candidate) { const score = Math.max(0, Math.min(100, Math.round(candidate.baseScore || 0))); return { score, grade: score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F' }; }
  getReversalPoints(symbol = 'SPY') { return this.pointsBySymbol.get(String(symbol || 'SPY').toUpperCase()) || []; }
  clearReversalPoints(symbol = 'SPY') { const s = String(symbol || 'SPY').toUpperCase(); const cleared = this.pointsBySymbol.delete(s); return { symbol: s, cleared }; }
  build(symbol, timeframe, direction, baseScore, reasons, supportingSignals, warnings, context, quantFeatures = [], qualityScores = []) {
    let scoreBase = baseScore;
    const labels = quantFeatures.map((f) => `${f?.name || ''} ${f?.type || ''} ${f?.reason || ''}`.toLowerCase());
    if (labels.some((l) => l.includes('rsi') && (l.includes('exhaust') || l.includes('overbought') || l.includes('oversold')))) { scoreBase += 8; reasons.push('RSI exhaustion/extension context bonus (+8).'); }
    if (labels.some((l) => l.includes('volume') && l.includes('spike'))) { scoreBase += 6; reasons.push('Volume spike support bonus (+6).'); }
    if (labels.some((l) => l.includes('failed breakout') || l.includes('failed break'))) { scoreBase += 6; reasons.push('Failed breakout support bonus (+6).'); }
    const hasAB = qualityScores.some((q) => q?.grade === 'A' || q?.grade === 'B'); if (hasAB) { scoreBase += 8; reasons.push('Quality score grade A/B support bonus (+8).'); }
    if (warnings.length > 0) scoreBase -= Math.min(15, warnings.length * 5);
    const { score, grade } = this.scoreReversal({ baseScore: scoreBase });
    const zone = this.zone(context, symbol, timeframe);
    const invalidationLevel = direction === 'short' ? zone.openingRangeHigh || zone.sessionHigh : zone.openingRangeLow || zone.sessionLow;
    const invalidationCondition = direction === 'short' ? `Invalidate if price sustains above ${invalidationLevel || 'openingRangeHigh'} with acceptance.` : `Invalidate if price sustains below ${invalidationLevel || 'openingRangeLow'} with acceptance.`;
    const targetReference = zone.vwap || context?.previousClose || zone.openingRangeMidpoint;
    return createReversalPoint({
      id: `${symbol}-${timeframe}-${direction}-${Date.now()}`,
      symbol, timeframe, direction, score, grade, zone,
      entrySuggestion: `Observe for ${direction} confirmation behavior at/near the zone before any discretionary action.`,
      stopSuggestion: `Use a risk boundary around invalidation reference ${invalidationLevel || 'session level'}.`,
      targetSuggestion: `Potential reference targets: VWAP, previous close, opening-range midpoint, or roughly 2R toward ${targetReference || 'reference level'}.`,
      invalidationCondition, reasons, supportingSignals, warnings, source: context?.source || 'derived', createdAt: new Date().toISOString(),
    });
  }
  zone(context, symbol, timeframe) { const high = Number(context?.openingRangeHigh || 0); const low = Number(context?.openingRangeLow || 0); return { openingRangeHigh: high, openingRangeLow: low, openingRangeMidpoint: high && low ? Math.round(((high + low) / 2) * 10000) / 10000 : 0, vwap: Number(context?.vwap || 0), sessionHigh: Number(context?.sessionHigh || 0), sessionLow: Number(context?.sessionLow || 0), price: this.latestPrice(symbol, timeframe) }; }
  latestPrice(symbol, timeframe) { const candles = getCandles(symbol, timeframe); return candles.length ? Number(candles[candles.length - 1]?.c || 0) : 0; }
  near(price, level) { if (!price || !level) return false; return Math.abs(price - level) / Math.abs(level) <= 0.0025; }
  norm(direction) { const v = String(direction || '').toLowerCase(); if (v === 'long' || v.includes('bull')) return 'bullish'; if (v === 'short' || v.includes('bear')) return 'bearish'; return 'neutral'; }
  dedupe(points = []) { const seen = new Set(); return points.filter((p) => { const k = `${p.direction}-${p.grade}-${p.zone?.openingRangeHigh}-${p.zone?.openingRangeLow}`; if (seen.has(k)) return false; seen.add(k); return true; }); }
}

export const reversalDetectorEngine = new ReversalDetectorEngine();
