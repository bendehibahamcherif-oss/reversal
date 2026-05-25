import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AnalysisSnapshot } from './analysisSnapshot.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

class AnalysisHistoryStore {
  constructor() {
    this.memorySnapshots = [];
  }

  isMongoAvailable() {
    return mongoose.connection?.readyState === 1;
  }

  normalizeSnapshot(snapshot = {}) {
    const normalized = {
      symbol: String(snapshot.symbol || '').toUpperCase(),
      timeframe: String(snapshot.timeframe || '1m'),
      alphaSignals: this.safeArray(snapshot.alphaSignals),
      patternSignals: this.safeArray(snapshot.patternSignals),
      strategyCandidates: this.safeArray(snapshot.strategyCandidates),
      quantFeatures: this.safeArray(snapshot.quantFeatures),
      qualityScores: this.safeArray(snapshot.qualityScores),
      rankedSignals: this.safeArray(snapshot.rankedSignals),
      warnings: this.safeArray(snapshot.warnings),
      createdAt: snapshot.createdAt ? new Date(snapshot.createdAt) : new Date(),
    };

    return normalized;
  }

  toPublicShape(snapshot) {
    return {
      id: String(snapshot.id || snapshot._id || randomUUID()),
      symbol: String(snapshot.symbol || '').toUpperCase(),
      timeframe: String(snapshot.timeframe || '1m'),
      alphaSignals: this.safeArray(snapshot.alphaSignals),
      patternSignals: this.safeArray(snapshot.patternSignals),
      strategyCandidates: this.safeArray(snapshot.strategyCandidates),
      quantFeatures: this.safeArray(snapshot.quantFeatures),
      qualityScores: this.safeArray(snapshot.qualityScores),
      rankedSignals: this.safeArray(snapshot.rankedSignals),
      warnings: this.safeArray(snapshot.warnings),
      createdAt: snapshot.createdAt ? new Date(snapshot.createdAt).toISOString() : new Date().toISOString(),
    };
  }

  safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  safeLimit(limit) {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
    return Math.min(parsed, MAX_LIMIT);
  }

  async saveSnapshot(snapshot) {
    const normalized = this.normalizeSnapshot(snapshot);

    if (this.isMongoAvailable()) {
      try {
        const created = await AnalysisSnapshot.create(normalized);
        return this.toPublicShape(created.toJSON());
      } catch (err) {
        console.warn(`Analysis history Mongo save failed, using in-memory fallback: ${err.message}`);
      }
    }

    const memoryEntry = {
      id: randomUUID(),
      ...normalized,
      createdAt: normalized.createdAt.toISOString(),
    };
    this.memorySnapshots.unshift(memoryEntry);
    return this.toPublicShape(memoryEntry);
  }

  async getSnapshots(symbol, limit = DEFAULT_LIMIT) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const safeLimit = this.safeLimit(limit);

    if (this.isMongoAvailable()) {
      try {
        const query = normalizedSymbol ? { symbol: normalizedSymbol } : {};
        const results = await AnalysisSnapshot.find(query).sort({ createdAt: -1 }).limit(safeLimit).lean();
        return results.map((item) => this.toPublicShape(item));
      } catch (err) {
        console.warn(`Analysis history Mongo read failed, using in-memory fallback: ${err.message}`);
      }
    }

    return this.memorySnapshots
      .filter((item) => !normalizedSymbol || item.symbol === normalizedSymbol)
      .slice(0, safeLimit)
      .map((item) => this.toPublicShape(item));
  }

  async getSnapshotById(id) {
    const snapshotId = String(id || '');
    if (!snapshotId) return null;

    if (this.isMongoAvailable()) {
      try {
        if (!mongoose.isValidObjectId(snapshotId)) return null;
        const result = await AnalysisSnapshot.findById(snapshotId).lean();
        return result ? this.toPublicShape(result) : null;
      } catch (err) {
        console.warn(`Analysis history Mongo lookup failed, using in-memory fallback: ${err.message}`);
      }
    }

    const local = this.memorySnapshots.find((item) => item.id === snapshotId);
    return local ? this.toPublicShape(local) : null;
  }

  async clearSnapshots(symbol) {
    const normalizedSymbol = String(symbol || '').toUpperCase();

    if (this.isMongoAvailable()) {
      try {
        const query = normalizedSymbol ? { symbol: normalizedSymbol } : {};
        const result = await AnalysisSnapshot.deleteMany(query);
        return { deleted: result.deletedCount || 0 };
      } catch (err) {
        console.warn(`Analysis history Mongo clear failed, using in-memory fallback: ${err.message}`);
      }
    }

    const before = this.memorySnapshots.length;
    this.memorySnapshots = normalizedSymbol
      ? this.memorySnapshots.filter((item) => item.symbol !== normalizedSymbol)
      : [];

    return { deleted: before - this.memorySnapshots.length };
  }
}

export const analysisHistoryStore = new AnalysisHistoryStore();
