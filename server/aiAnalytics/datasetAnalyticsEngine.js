import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { featureStore } from '../ai/featureStore.js';
import { outcomeLabeler } from '../ai/outcomeLabeler.js';
import { DatasetAnalytics } from './datasetAnalytics.js';

class DatasetAnalyticsEngine {
  constructor() { this.memory = []; }
  isMongoAvailable() { return mongoose.connection?.readyState === 1; }

  async analyzeDataset(symbol, timeframe = '1m') {
    const s = String(symbol || '').toUpperCase();
    const features = (await featureStore.getFeatureRecords(s, 200)).filter((x) => x.timeframe === timeframe);
    const labels = (await outcomeLabeler.getOutcomeLabels(s, 400)).filter((x) => x.timeframe === timeframe);
    const warnings = [];
    if (!features.length) warnings.push('No feature records available for selected symbol/timeframe.');
    if (!labels.length) warnings.push('No outcome labels available; analytics may be incomplete.');

    const labelDistribution = labels.reduce((acc, l) => { const k = l.label || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const sum = (arr, field) => arr.reduce((a, x) => a + Number(x[field] || 0), 0);
    const averageFutureReturn = labels.length ? sum(labels, 'futureReturn') / labels.length : 0;
    const averageMFE = labels.length ? sum(labels, 'maxFavorableExcursion') / labels.length : 0;
    const averageMAE = labels.length ? sum(labels, 'maxAdverseExcursion') / labels.length : 0;
    const wins = labels.filter((x) => Number(x.futureReturn || 0) > 0).length;
    const losses = labels.filter((x) => Number(x.futureReturn || 0) < 0).length;
    const winRate = labels.length ? wins / labels.length : 0;
    const avgWin = wins ? labels.filter((x) => Number(x.futureReturn || 0) > 0).reduce((a, x) => a + Number(x.futureReturn || 0), 0) / wins : 0;
    const avgLoss = losses ? labels.filter((x) => Number(x.futureReturn || 0) < 0).reduce((a, x) => a + Math.abs(Number(x.futureReturn || 0)), 0) / losses : 0;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

    const regimeBreakdown = features.reduce((acc, f) => {
      const k = f.marketRegime || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    const featureStatistics = this.analyzeFeatureImportance(features, labels);

    const analytics = {
      id: randomUUID(),
      symbol: s,
      timeframe,
      totalFeatureRecords: features.length,
      totalOutcomeLabels: labels.length,
      labelDistribution,
      averageFutureReturn,
      averageMFE,
      averageMAE,
      winRate,
      expectancy,
      regimeBreakdown,
      featureStatistics,
      warnings,
      createdAt: new Date().toISOString(),
    };

    return this.saveAnalytics(analytics);
  }

  analyzeFeatureImportance(features = [], labels = []) {
    const paired = new Map(labels.map((x) => [String(x.featureRecordId), x]));
    const stats = {};
    for (const feature of features) {
      const label = paired.get(String(feature.id));
      if (!label) continue;
      for (const q of (feature.quantFeatures || [])) {
        const key = String(q?.name || q?.feature || 'unknown_feature');
        const value = Number(q?.value ?? q?.score ?? NaN);
        if (!Number.isFinite(value)) continue;
        if (!stats[key]) stats[key] = { count: 0, valueSum: 0, returnSum: 0 };
        stats[key].count += 1;
        stats[key].valueSum += value;
        stats[key].returnSum += Number(label.futureReturn || 0);
      }
    }
    const out = {};
    Object.entries(stats).forEach(([k, v]) => {
      out[k] = {
        samples: v.count,
        averageValue: v.count ? v.valueSum / v.count : 0,
        averageFutureReturn: v.count ? v.returnSum / v.count : 0,
      };
    });
    return out;
  }

  async saveAnalytics(analytics) {
    if (this.isMongoAvailable()) {
      try { const created = await DatasetAnalytics.create(analytics); return created.toJSON(); } catch (err) { console.warn(`DatasetAnalyticsEngine Mongo save failed, using in-memory fallback: ${err.message}`); }
    }
    this.memory.unshift(analytics);
    return analytics;
  }
}

export const datasetAnalyticsEngine = new DatasetAnalyticsEngine();
