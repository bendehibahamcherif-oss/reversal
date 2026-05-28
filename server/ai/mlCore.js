import { randomUUID } from 'node:crypto';

export function nowIso() { return new Date().toISOString(); }
export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
export function featureVectorFromRecord(record = {}) {
  const quant = Array.isArray(record.quantFeatures) ? record.quantFeatures : [];
  const quality = Array.isArray(record.qualityScores) ? record.qualityScores : [];
  const scalar = {
    alphaSignalCount: Array.isArray(record.alphaSignals) ? record.alphaSignals.length : 0,
    patternSignalCount: Array.isArray(record.patternSignals) ? record.patternSignals.length : 0,
    strategyCandidateCount: Array.isArray(record.strategyCandidates) ? record.strategyCandidates.length : 0,
    reversalPointCount: Array.isArray(record.reversalPoints) ? record.reversalPoints.length : 0,
    sessionTrendBias: safeNumber(record.sessionContext?.sessionTrendBias, 0),
    sessionVolatilityRisk: safeNumber(record.sessionContext?.volatilityRisk, 0)
  };
  for (const item of quant) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key || item.name || '').trim();
    if (!key) continue;
    scalar[`quant_${key}`] = safeNumber(item.value, 0);
  }
  for (const item of quality) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.metric || item.key || '').trim();
    if (!key) continue;
    scalar[`quality_${key}`] = safeNumber(item.score, safeNumber(item.value, 0));
  }
  return scalar;
}
export function normalizeRows(rows = []) {
  if (!rows.length) return { rows: [], stats: {} };
  const keys = Object.keys(rows[0].features || {});
  const stats = {};
  for (const k of keys) {
    const vals = rows.map((r) => safeNumber(r.features[k], 0));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((acc, x) => acc + (x - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1;
    stats[k] = { mean, std };
  }
  const normalized = rows.map((r) => {
    const features = {};
    for (const k of keys) features[k] = (safeNumber(r.features[k], 0) - stats[k].mean) / stats[k].std;
    return { ...r, features };
  });
  return { rows: normalized, stats };
}
export function createId(prefix) { return `${prefix}_${randomUUID()}`; }
