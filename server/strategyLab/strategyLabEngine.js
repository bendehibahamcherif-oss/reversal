import { strategyEngine } from '../strategies/strategyEngine.js';
import { strategyLabStore } from './strategyLabStore.js';

const SAFE_STATUS = new Set(['draft', 'active', 'archived', 'research_only', 'needs_confirmation']);

class StrategyLabEngine {
  normalizeSymbol(symbol) { return String(symbol || '').trim().toUpperCase(); }

  listStrategies(symbol) { return strategyLabStore.list(this.normalizeSymbol(symbol)); }

  getStrategy(id) { return strategyLabStore.getById(id)?.strategy || null; }

  save(symbol, payload = {}) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const fromCandidate = payload?.candidateId ? this.fromCandidate(normalizedSymbol, payload.candidateId) : null;
    const manual = this.fromManual(normalizedSymbol, payload);
    const strategy = fromCandidate || manual;
    if (!strategy) {
      throw new Error('Unable to build strategy from candidateId or manual strategy body');
    }
    strategyLabStore.upsert(normalizedSymbol, strategy);
    return strategy;
  }

  update(id, patch = {}) {
    const found = strategyLabStore.getById(id);
    if (!found) return null;
    const safe = this.safePatch(patch);
    const updated = { ...found.strategy, ...safe, updatedAt: new Date().toISOString() };
    strategyLabStore.upsert(found.symbol, updated);
    return updated;
  }

  delete(id) { return strategyLabStore.remove(id); }
  clear(symbol) { return strategyLabStore.clear(this.normalizeSymbol(symbol)); }

  compare(symbol, body = {}) {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const strategies = this.listStrategies(normalizedSymbol);
    const ids = Array.isArray(body.strategyIds) && body.strategyIds.length
      ? body.strategyIds.map((id) => String(id))
      : strategies.map((s) => s.id);
    const selected = strategies.filter((s) => ids.includes(s.id));
    const ranked = selected
      .map((s) => ({ id: s.id, name: s.name, status: s.status, score: this.score(s) }))
      .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
    return {
      success: true,
      symbol: normalizedSymbol,
      comparedCount: ranked.length,
      winner: ranked[0] || null,
      rankings: ranked,
      methodology: 'deterministic-static-v1',
    };
  }

  fromCandidate(symbol, candidateId) {
    const c = strategyEngine.getStrategies(symbol).find((x) => x.id === String(candidateId));
    if (!c) return null;
    return {
      id: `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol,
      name: c.name || `${symbol} Candidate Strategy`,
      logic: c.reason || c.description || 'Candidate-derived strategy logic',
      notes: '',
      tags: ['candidate-import'],
      risk: { level: c.riskLevel || 'medium' },
      status: c.status || 'draft',
      sourceCandidateId: c.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  fromManual(symbol, payload) {
    if (!payload || typeof payload !== 'object') return null;
    const name = String(payload.name || '').trim();
    const logic = String(payload.logic || '').trim();
    if (!name && !logic) return null;
    return {
      id: String(payload.id || `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      symbol,
      name: name || `${symbol} Manual Strategy`,
      logic,
      notes: String(payload.notes || ''),
      tags: Array.isArray(payload.tags) ? payload.tags.map((t) => String(t)) : [],
      risk: payload.risk && typeof payload.risk === 'object' ? payload.risk : { level: 'medium' },
      status: SAFE_STATUS.has(String(payload.status)) ? String(payload.status) : 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  safePatch(patch) {
    const out = {};
    if ('notes' in patch) out.notes = String(patch.notes || '');
    if ('logic' in patch) out.logic = String(patch.logic || '');
    if ('tags' in patch) out.tags = Array.isArray(patch.tags) ? patch.tags.map((t) => String(t)) : [];
    if ('status' in patch && SAFE_STATUS.has(String(patch.status))) out.status = String(patch.status);
    if ('risk' in patch && patch.risk && typeof patch.risk === 'object') out.risk = patch.risk;
    return out;
  }

  score(strategy) {
    const statusWeight = { active: 25, draft: 10, archived: 0, research_only: 2, needs_confirmation: 4 };
    const riskWeight = { low: 20, medium: 12, high: 4 };
    const tagCount = Array.isArray(strategy.tags) ? strategy.tags.length : 0;
    const riskLevel = String(strategy?.risk?.level || 'medium').toLowerCase();
    return (statusWeight[strategy.status] ?? 8) + (riskWeight[riskLevel] ?? 10) + Math.min(10, tagCount * 2) + Math.min(20, String(strategy.logic || '').length / 20);
  }
}

export const strategyLabEngine = new StrategyLabEngine();
