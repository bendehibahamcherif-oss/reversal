let validationCounter = 0;

export function createStrategyValidationResult(input = {}) {
  validationCounter += 1;
  const now = new Date().toISOString();

  return {
    id: input.id || `validation-${Date.now()}-${validationCounter}`,
    symbol: String(input.symbol || '').toUpperCase(),
    strategyId: String(input.strategyId || ''),
    strategyName: String(input.strategyName || 'Unknown Strategy'),
    validationScore: Number(input.validationScore || 0),
    grade: String(input.grade || 'F'),
    status: String(input.status || 'rejected'),
    reasons: Array.isArray(input.reasons) ? input.reasons : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    backtestSummary: input.backtestSummary && typeof input.backtestSummary === 'object' ? input.backtestSummary : {},
    qualitySummary: input.qualitySummary && typeof input.qualitySummary === 'object' ? input.qualitySummary : {},
    riskSummary: input.riskSummary && typeof input.riskSummary === 'object' ? input.riskSummary : {},
    createdAt: input.createdAt || now,
  };
}
