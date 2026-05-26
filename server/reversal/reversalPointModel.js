export function createReversalPoint(payload = {}) {
  return {
    id: payload.id, symbol: payload.symbol, timeframe: payload.timeframe, direction: payload.direction,
    score: payload.score, grade: payload.grade, zone: payload.zone || null,
    entrySuggestion: payload.entrySuggestion, stopSuggestion: payload.stopSuggestion, targetSuggestion: payload.targetSuggestion,
    invalidationCondition: payload.invalidationCondition, reasons: Array.isArray(payload.reasons) ? payload.reasons : [],
    supportingSignals: Array.isArray(payload.supportingSignals) ? payload.supportingSignals : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [], source: payload.source, createdAt: payload.createdAt,
  };
}
