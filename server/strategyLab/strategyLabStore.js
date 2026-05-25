import mongoose from 'mongoose';
import { createSavedStrategy } from './savedStrategy.js';
import { SavedStrategy } from './strategyLabModel.js';

class StrategyLabStore {
  constructor() {
    this.memoryStrategies = [];
  }

  isMongoAvailable() {
    return mongoose.connection?.readyState === 1;
  }

  toPublicShape(strategy = {}) {
    return createSavedStrategy({
      ...strategy,
      id: String(strategy.id || strategy._id || ''),
      createdAt: strategy.createdAt,
      updatedAt: strategy.updatedAt,
    });
  }

  async saveStrategy(strategy) {
    const normalized = createSavedStrategy(strategy);

    if (this.isMongoAvailable()) {
      try {
        const created = await SavedStrategy.create({ ...normalized, id: undefined });
        return this.toPublicShape(created.toJSON());
      } catch (err) {
        console.warn(`Strategy Lab Mongo save failed, using in-memory fallback: ${err.message}`);
      }
    }

    this.memoryStrategies.unshift(normalized);
    return this.toPublicShape(normalized);
  }

  async getStrategies(symbol) {
    const normalizedSymbol = String(symbol || '').toUpperCase();

    if (this.isMongoAvailable()) {
      try {
        const query = normalizedSymbol ? { symbol: normalizedSymbol } : {};
        const rows = await SavedStrategy.find(query).sort({ updatedAt: -1 }).lean();
        return rows.map((row) => this.toPublicShape(row));
      } catch (err) {
        console.warn(`Strategy Lab Mongo read failed, using in-memory fallback: ${err.message}`);
      }
    }

    return this.memoryStrategies
      .filter((item) => !normalizedSymbol || item.symbol === normalizedSymbol)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((item) => this.toPublicShape(item));
  }

  async getStrategyById(id) {
    const strategyId = String(id || '');
    if (!strategyId) return null;

    if (this.isMongoAvailable()) {
      try {
        if (!mongoose.isValidObjectId(strategyId)) return null;
        const row = await SavedStrategy.findById(strategyId).lean();
        return row ? this.toPublicShape(row) : null;
      } catch (err) {
        console.warn(`Strategy Lab Mongo lookup failed, using in-memory fallback: ${err.message}`);
      }
    }

    const local = this.memoryStrategies.find((item) => item.id === strategyId);
    return local ? this.toPublicShape(local) : null;
  }

  async updateStrategy(id, updates = {}) {
    const strategyId = String(id || '');
    if (!strategyId) return null;

    if (this.isMongoAvailable()) {
      try {
        if (!mongoose.isValidObjectId(strategyId)) return null;
        const updated = await SavedStrategy.findByIdAndUpdate(strategyId, { ...updates, updatedAt: new Date() }, { new: true }).lean();
        return updated ? this.toPublicShape(updated) : null;
      } catch (err) {
        console.warn(`Strategy Lab Mongo update failed, using in-memory fallback: ${err.message}`);
      }
    }

    const index = this.memoryStrategies.findIndex((item) => item.id === strategyId);
    if (index < 0) return null;

    const merged = createSavedStrategy({
      ...this.memoryStrategies[index],
      ...updates,
      id: strategyId,
      createdAt: this.memoryStrategies[index].createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.memoryStrategies[index] = merged;
    return this.toPublicShape(merged);
  }

  async deleteStrategy(id) {
    const strategyId = String(id || '');
    if (!strategyId) return { deleted: 0 };

    if (this.isMongoAvailable()) {
      try {
        if (!mongoose.isValidObjectId(strategyId)) return { deleted: 0 };
        const result = await SavedStrategy.deleteOne({ _id: strategyId });
        return { deleted: result.deletedCount || 0 };
      } catch (err) {
        console.warn(`Strategy Lab Mongo delete failed, using in-memory fallback: ${err.message}`);
      }
    }

    const before = this.memoryStrategies.length;
    this.memoryStrategies = this.memoryStrategies.filter((item) => item.id !== strategyId);
    return { deleted: before - this.memoryStrategies.length };
  }

  async clearStrategies(symbol) {
    const normalizedSymbol = String(symbol || '').toUpperCase();

    if (this.isMongoAvailable()) {
      try {
        const result = await SavedStrategy.deleteMany(normalizedSymbol ? { symbol: normalizedSymbol } : {});
        return { deleted: result.deletedCount || 0 };
      } catch (err) {
        console.warn(`Strategy Lab Mongo clear failed, using in-memory fallback: ${err.message}`);
      }
    }

    const before = this.memoryStrategies.length;
    this.memoryStrategies = normalizedSymbol
      ? this.memoryStrategies.filter((item) => item.symbol !== normalizedSymbol)
      : [];

    return { deleted: before - this.memoryStrategies.length };
  }
}

export const strategyLabStore = new StrategyLabStore();
