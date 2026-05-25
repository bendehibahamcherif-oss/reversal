import { analysisHistoryStore } from '../history/analysisHistoryStore.js';
import { createSnapshotComparison } from './snapshotComparison.js';

class AnalysisTrendEngine {
  safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  averageQuality(snapshot = {}) {
    const scores = this.safeArray(snapshot.qualityScores)
      .map((score) => Number(score?.score ?? score?.qualityScore ?? score))
      .filter((v) => Number.isFinite(v));
    if (!scores.length) return 0;
    return scores.reduce((sum, v) => sum + v, 0) / scores.length;
  }

  directionBias(snapshot = {}) {
    const ranked = this.safeArray(snapshot.rankedSignals);
    const quality = this.safeArray(snapshot.qualityScores);
    const pool = ranked.length ? ranked : quality;

    let bullish = 0;
    let bearish = 0;
    for (const item of pool) {
      const direction = String(item?.direction || item?.bias || '').toLowerCase();
      if (direction.includes('bull')) bullish += 1;
      else if (direction.includes('bear')) bearish += 1;
    }

    if (bullish > bearish) return 'bullish';
    if (bearish > bullish) return 'bearish';
    return 'neutral';
  }

  confidenceShift(delta) {
    if (delta > 0.01) return 'improved';
    if (delta < -0.01) return 'degraded';
    return 'flat';
  }

  async compareSnapshots(symbol, baseSnapshotId, compareSnapshotId) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const warnings = [];

    const [baseSnapshot, compareSnapshot] = await Promise.all([
      analysisHistoryStore.getSnapshotById(baseSnapshotId),
      analysisHistoryStore.getSnapshotById(compareSnapshotId),
    ]);

    if (!baseSnapshot) warnings.push('Base snapshot not found');
    if (!compareSnapshot) warnings.push('Compare snapshot not found');

    const base = baseSnapshot || { symbol: normalizedSymbol };
    const compare = compareSnapshot || { symbol: normalizedSymbol };

    if (!this.safeArray(base.alphaSignals).length || !this.safeArray(compare.alphaSignals).length) {
      warnings.push('Sparse alpha signal data for one or both snapshots');
    }

    const baseQuality = this.averageQuality(base);
    const compareQuality = this.averageQuality(compare);

    return createSnapshotComparison({
      symbol: normalizedSymbol,
      baseSnapshotId,
      compareSnapshotId,
      timeframe: compare.timeframe || base.timeframe || 'unknown',
      alphaDelta: this.safeArray(compare.alphaSignals).length - this.safeArray(base.alphaSignals).length,
      patternDelta: this.safeArray(compare.patternSignals).length - this.safeArray(base.patternSignals).length,
      strategyDelta: this.safeArray(compare.strategyCandidates).length - this.safeArray(base.strategyCandidates).length,
      quantFeatureDelta: this.safeArray(compare.quantFeatures).length - this.safeArray(base.quantFeatures).length,
      qualityScoreDelta: Number((compareQuality - baseQuality).toFixed(6)),
      directionShift: `${this.directionBias(base)}_to_${this.directionBias(compare)}`,
      confidenceShift: this.confidenceShift(compareQuality - baseQuality),
      warnings,
    });
  }

  async computeQualityTrend(symbol, limit = 25) {
    const snapshots = await analysisHistoryStore.getSnapshots(symbol, limit);
    return snapshots.slice().reverse().map((snapshot) => ({
      snapshotId: snapshot.id,
      symbol: snapshot.symbol,
      timeframe: snapshot.timeframe,
      createdAt: snapshot.createdAt,
      averageQualityScore: this.averageQuality(snapshot),
    }));
  }

  async computeSignalDirectionTrend(symbol, limit = 25) {
    const snapshots = await analysisHistoryStore.getSnapshots(symbol, limit);
    return snapshots.slice().reverse().map((snapshot) => ({
      snapshotId: snapshot.id,
      symbol: snapshot.symbol,
      createdAt: snapshot.createdAt,
      directionBias: this.directionBias(snapshot),
      alphaSignalCount: this.safeArray(snapshot.alphaSignals).length,
      patternSignalCount: this.safeArray(snapshot.patternSignals).length,
      strategyCandidateCount: this.safeArray(snapshot.strategyCandidates).length,
    }));
  }

  async computeTrend(symbol, limit = 25) {
    const snapshots = await analysisHistoryStore.getSnapshots(symbol, limit);
    const ordered = snapshots.slice().reverse();

    return {
      symbol: String(symbol || '').toUpperCase(),
      points: ordered.map((snapshot) => ({
        snapshotId: snapshot.id,
        createdAt: snapshot.createdAt,
        timeframe: snapshot.timeframe,
        signalCount:
          this.safeArray(snapshot.alphaSignals).length
          + this.safeArray(snapshot.patternSignals).length
          + this.safeArray(snapshot.strategyCandidates).length,
        quantFeatureCount: this.safeArray(snapshot.quantFeatures).length,
        averageQualityScore: this.averageQuality(snapshot),
        directionBias: this.directionBias(snapshot),
      })),
      qualityTrend: await this.computeQualityTrend(symbol, limit),
      directionTrend: await this.computeSignalDirectionTrend(symbol, limit),
      warnings: snapshots.length ? [] : ['No analysis snapshots available for requested symbol'],
    };
  }

  async getLatestTrend(symbol) {
    const snapshots = await analysisHistoryStore.getSnapshots(symbol, 2);
    const [latest, previous] = snapshots;

    if (!latest) {
      return {
        symbol: String(symbol || '').toUpperCase(),
        latestSnapshotId: null,
        trend: null,
        warnings: ['No analysis snapshots available for requested symbol'],
      };
    }

    if (!previous) {
      return {
        symbol: String(symbol || '').toUpperCase(),
        latestSnapshotId: latest.id,
        trend: null,
        warnings: ['Need at least two snapshots for latest trend comparison'],
      };
    }

    const trend = await this.compareSnapshots(symbol, previous.id, latest.id);
    return {
      symbol: String(symbol || '').toUpperCase(),
      latestSnapshotId: latest.id,
      trend,
      warnings: trend.warnings,
    };
  }
}

export const analysisTrendEngine = new AnalysisTrendEngine();
