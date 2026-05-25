class StrategyLabStore {
  constructor() {
    this.strategiesBySymbol = new Map();
  }

  normalizeSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase();
  }

  list(symbol) {
    return [...(this.strategiesBySymbol.get(this.normalizeSymbol(symbol)) || [])];
  }

  getById(id) {
    const needle = String(id || '').trim();
    for (const [symbol, strategies] of this.strategiesBySymbol.entries()) {
      const found = strategies.find((s) => s.id === needle);
      if (found) return { symbol, strategy: found };
    }
    return null;
  }

  upsert(symbol, strategy) {
    const key = this.normalizeSymbol(symbol);
    const current = this.list(key);
    const idx = current.findIndex((s) => s.id === strategy.id);
    if (idx >= 0) {
      current[idx] = strategy;
    } else {
      current.push(strategy);
    }
    this.strategiesBySymbol.set(key, current);
    return strategy;
  }

  remove(id) {
    const needle = String(id || '').trim();
    for (const [symbol, strategies] of this.strategiesBySymbol.entries()) {
      const next = strategies.filter((s) => s.id !== needle);
      if (next.length !== strategies.length) {
        this.strategiesBySymbol.set(symbol, next);
        return true;
      }
    }
    return false;
  }

  clear(symbol) {
    const key = this.normalizeSymbol(symbol);
    this.strategiesBySymbol.set(key, []);
    return [];
  }
}

export const strategyLabStore = new StrategyLabStore();
