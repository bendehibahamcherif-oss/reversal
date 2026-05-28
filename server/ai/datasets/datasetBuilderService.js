import { featureStore } from '../featureStore.js';
import { outcomeLabeler } from '../outcomeLabeler.js';
import { createId, featureVectorFromRecord, normalizeRows, nowIso } from '../mlCore.js';

class DatasetBuilderService {
  constructor() { this.datasets = new Map(); }
  async createDataset({ symbol, timeframe = '1m', limit = 500, normalize = true, featureAllowList = [] } = {}) {
    const s = String(symbol || '').toUpperCase();
    const warnings = [];
    if (!s) return { ok: false, errors: ['symbol is required'], warnings };
    const features = (await featureStore.getFeatureRecords(s, Math.max(Number(limit) || 500, 50))).filter((x) => x.timeframe === timeframe);
    const labels = (await outcomeLabeler.getOutcomeLabels(s, Math.max(Number(limit) || 500, 50))).filter((x) => x.timeframe === timeframe);
    const labelByRecordId = new Map(labels.map((l) => [String(l.featureRecordId), l]));
    const rows = [];
    let missingLabels = 0;
    for (const f of features) {
      const label = labelByRecordId.get(String(f.id));
      if (!label) { missingLabels += 1; continue; }
      const rawFeatures = featureVectorFromRecord(f);
      const filtered = Array.isArray(featureAllowList) && featureAllowList.length
        ? Object.fromEntries(Object.entries(rawFeatures).filter(([k]) => featureAllowList.includes(k)))
        : rawFeatures;
      rows.push({ id: createId('row'), featureRecordId: f.id, timestamp: f.timestamp, symbol: s, timeframe, features: filtered, label: label.label || label.outcome || 'unknown', regime: f.marketRegime || 'unknown' });
    }
    if (missingLabels) warnings.push(`Excluded ${missingLabels} feature rows without labels.`);
    if (!rows.length) return { ok: false, errors: ['No rows available after label merge.'], warnings };
    const featureNames = [...new Set(rows.flatMap((r) => Object.keys(r.features)))].sort();
    const missingFeatureStats = {};
    for (const name of featureNames) missingFeatureStats[name] = rows.reduce((acc, r) => acc + (Number.isFinite(Number(r.features[name])) ? 0 : 1), 0);
    for (const row of rows) for (const name of featureNames) if (!Number.isFinite(Number(row.features[name]))) row.features[name] = 0;
    const consistent = rows.every((r) => typeof r.label === 'string' && r.label.length > 0);
    if (!consistent) warnings.push('Label consistency issue detected.');
    const normalized = normalize ? normalizeRows(rows) : { rows, stats: {} };
    const labelDistribution = normalized.rows.reduce((acc, r) => { acc[r.label] = (acc[r.label] || 0) + 1; return acc; }, {});
    const dataset = {
      datasetId: createId('dataset'),
      symbol: s,
      timeframe,
      rows: normalized.rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
      metadata: {
        symbol: s, timeframe, sampleCount: normalized.rows.length, featureCount: featureNames.length,
        missingValueStatistics: missingFeatureStats, labelDistribution, normalizationStats: normalized.stats,
        generationTimestamp: nowIso(), warnings
      }
    };
    this.datasets.set(dataset.datasetId, dataset);
    return { ok: true, datasetId: dataset.datasetId, metadata: dataset.metadata, warnings };
  }
  inspectDataset(datasetId) { const data = this.datasets.get(String(datasetId || '')); if (!data) return null; return { datasetId: data.datasetId, symbol: data.symbol, timeframe: data.timeframe, metadata: data.metadata }; }
  getDatasetById(datasetId) { return this.datasets.get(String(datasetId || '')) || null; }
}

export const datasetBuilderService = new DatasetBuilderService();
