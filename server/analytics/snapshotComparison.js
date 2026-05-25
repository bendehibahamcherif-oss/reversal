import { randomUUID } from 'node:crypto';

export function createSnapshotComparison(payload = {}) {
  return {
    id: String(payload.id || randomUUID()),
    symbol: String(payload.symbol || '').toUpperCase(),
    baseSnapshotId: payload.baseSnapshotId ? String(payload.baseSnapshotId) : null,
    compareSnapshotId: payload.compareSnapshotId ? String(payload.compareSnapshotId) : null,
    timeframe: String(payload.timeframe || 'unknown'),
    alphaDelta: Number(payload.alphaDelta || 0),
    patternDelta: Number(payload.patternDelta || 0),
    strategyDelta: Number(payload.strategyDelta || 0),
    quantFeatureDelta: Number(payload.quantFeatureDelta || 0),
    qualityScoreDelta: Number(payload.qualityScoreDelta || 0),
    directionShift: String(payload.directionShift || 'neutral_to_neutral'),
    confidenceShift: String(payload.confidenceShift || 'flat'),
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    createdAt: payload.createdAt ? new Date(payload.createdAt).toISOString() : new Date().toISOString(),
  };
}
