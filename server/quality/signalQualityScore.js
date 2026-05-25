let qualityCounter = 0;

export function createSignalQualityScore(input = {}) {
  qualityCounter += 1;

  return {
    id: `quality-${Date.now()}-${qualityCounter}`,
    symbol: String(input.symbol || '').toUpperCase(),
    signalId: String(input.signalId || ''),
    signalType: String(input.signalType || 'unknown'),
    score: Number(input.score || 0),
    grade: String(input.grade || 'F'),
    reasons: Array.isArray(input.reasons) ? input.reasons : [],
    penalties: Array.isArray(input.penalties) ? input.penalties : [],
    bonuses: Array.isArray(input.bonuses) ? input.bonuses : [],
    createdAt: input.createdAt || new Date().toISOString(),
  };
}
