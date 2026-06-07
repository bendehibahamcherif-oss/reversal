import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataPath } from '../utils/storagePaths.js';

const STORE_FILE = dataPath('alertHistory.json');
const MAX_HISTORY = 500;

class AlertHistoryStore {
  constructor() {
    this._history = [];
    this._load();
  }

  _load() {
    try {
      if (!existsSync(STORE_FILE)) return;
      const data = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
      if (Array.isArray(data.history)) {
        this._history = data.history;
        console.log('[AlertHistoryStore] loaded', { count: this._history.length });
      }
    } catch (e) {
      console.warn('[AlertHistoryStore] load failed:', e.message);
    }
  }

  _persist() {
    try {
      mkdirSync(dirname(STORE_FILE), { recursive: true });
      const trimmed = this._history.slice(-MAX_HISTORY);
      writeFileSync(STORE_FILE, JSON.stringify({ history: trimmed }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[AlertHistoryStore] persist failed:', e.message);
    }
  }

  record({ alertId, symbol, type, triggerValue, reason }) {
    const entry = {
      id: randomUUID(),
      alertId,
      symbol,
      type,
      triggerValue: triggerValue ?? null,
      reason: reason || '',
      triggeredAt: new Date().toISOString(),
    };
    this._history.push(entry);
    if (this._history.length > MAX_HISTORY) this._history = this._history.slice(-MAX_HISTORY);
    this._persist();
    return entry;
  }

  getAll(limit = 100) {
    return this._history.slice(-Math.min(limit, MAX_HISTORY)).reverse();
  }

  getByAlert(alertId, limit = 50) {
    return this._history
      .filter((h) => h.alertId === alertId)
      .slice(-Math.min(limit, MAX_HISTORY))
      .reverse();
  }
}

export const alertHistoryStore = new AlertHistoryStore();
