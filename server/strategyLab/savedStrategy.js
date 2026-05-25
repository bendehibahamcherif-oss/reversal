import { randomUUID } from 'node:crypto';

const ALLOWED_DIRECTIONS = new Set(['long', 'short', 'neutral']);

function sanitizeStatus(status) {
  const raw = String(status || '').trim().toLowerCase();
  if (!raw) return 'draft';

  if (raw === 'validated') return 'needs_validation';
  if (raw === 'approved') return 'needs_validation';
  return raw;
}

export function createSavedStrategy(input = {}) {
  const now = new Date().toISOString();

  return {
    id: String(input.id || randomUUID()),
    symbol: String(input.symbol || '').toUpperCase(),
    name: String(input.name || 'Unnamed Saved Strategy'),
    type: String(input.type || 'candidate'),
    status: sanitizeStatus(input.status),
    direction: ALLOWED_DIRECTIONS.has(input.direction) ? input.direction : 'neutral',
    timeframe: String(input.timeframe || '1m'),
    confidence: Math.max(0, Math.min(0.99, Number(input.confidence) || 0)),
    sourceCandidateId: input.sourceCandidateId ? String(input.sourceCandidateId) : '',
    entryLogic: String(input.entryLogic || ''),
    exitLogic: String(input.exitLogic || ''),
    riskRules: input.riskRules && typeof input.riskRules === 'object' ? input.riskRules : {},
    supportingSignals: Array.isArray(input.supportingSignals) ? input.supportingSignals : [],
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    tags: Array.isArray(input.tags) ? input.tags.map((tag) => String(tag)) : [],
    notes: String(input.notes || ''),
    backtestResults: Array.isArray(input.backtestResults) ? input.backtestResults : [],
    validationResults: Array.isArray(input.validationResults) ? input.validationResults : [],
    createdAt: input.createdAt ? new Date(input.createdAt).toISOString() : now,
    updatedAt: input.updatedAt ? new Date(input.updatedAt).toISOString() : now,
  };
}
