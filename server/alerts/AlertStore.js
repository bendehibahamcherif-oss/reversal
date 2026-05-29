import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE_FILE = '/var/data/alerts.json';

export const VALID_TYPES = new Set([
  'price_above', 'price_below', 'price_cross',
  'rsi_above', 'rsi_below',
  'ema_bullish_cross', 'ema_bearish_cross', 'price_above_ema', 'price_below_ema',
  'vwap_cross_up', 'vwap_cross_down',
  'poc_touch', 'poc_break', 'vah_touch', 'vah_break', 'val_touch', 'val_break',
  'volume_spike', 'relative_volume_spike',
]);

const VALID_COOLDOWN_MODES = new Set(['once', 'always', 'cooldown_minutes']);

class AlertStore {
  constructor() {
    this._alerts = new Map();
    this._load();
  }

  _load() {
    try {
      if (!existsSync(STORE_FILE)) return;
      const data = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
      if (Array.isArray(data.alerts)) {
        for (const a of data.alerts) this._alerts.set(a.id, a);
        console.log('[AlertStore] loaded', { count: this._alerts.size });
      }
    } catch (e) {
      console.warn('[AlertStore] load failed:', e.message);
    }
  }

  _persist() {
    try {
      mkdirSync(dirname(STORE_FILE), { recursive: true });
      writeFileSync(STORE_FILE, JSON.stringify({ alerts: Array.from(this._alerts.values()) }, null, 2), 'utf8');
    } catch (e) {
      console.warn('[AlertStore] persist failed:', e.message);
    }
  }

  create({ symbol, type, threshold = null, params = {}, cooldownMode = 'cooldown_minutes', cooldownMinutes = 60, expiresAt = null } = {}) {
    if (!symbol) throw new Error('symbol required');
    if (!VALID_TYPES.has(type)) throw new Error(`invalid alert type: ${type}. Valid: ${[...VALID_TYPES].join(', ')}`);
    if (!VALID_COOLDOWN_MODES.has(cooldownMode)) throw new Error(`invalid cooldownMode: ${cooldownMode}`);

    const alert = {
      id: randomUUID(),
      symbol: String(symbol).toUpperCase(),
      type,
      threshold: threshold != null ? Number(threshold) : null,
      params: params || {},
      enabled: true,
      cooldownMode,
      cooldownMinutes: Number(cooldownMinutes) || 60,
      expiresAt: expiresAt || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastTriggeredAt: null,
    };

    this._alerts.set(alert.id, alert);
    this._persist();
    console.log('[AlertStore] created', { id: alert.id, symbol: alert.symbol, type: alert.type });
    return alert;
  }

  get(id) {
    return this._alerts.get(String(id)) || null;
  }

  getAll(symbol = null) {
    const all = Array.from(this._alerts.values());
    return symbol ? all.filter((a) => a.symbol === String(symbol).toUpperCase()) : all;
  }

  getActive() {
    const now = new Date().toISOString();
    return Array.from(this._alerts.values()).filter((a) => {
      if (!a.enabled) return false;
      if (a.expiresAt && a.expiresAt < now) return false;
      return true;
    });
  }

  update(id, updates) {
    const alert = this._alerts.get(String(id));
    if (!alert) return null;
    if (updates.type !== undefined && !VALID_TYPES.has(updates.type)) throw new Error(`invalid alert type: ${updates.type}`);
    if (updates.cooldownMode !== undefined && !VALID_COOLDOWN_MODES.has(updates.cooldownMode)) throw new Error(`invalid cooldownMode: ${updates.cooldownMode}`);

    // Protect immutable fields
    const { id: _id, createdAt: _ca, ...safeUpdates } = updates;
    const updated = { ...alert, ...safeUpdates, id: alert.id, createdAt: alert.createdAt, updatedAt: new Date().toISOString() };
    this._alerts.set(alert.id, updated);
    this._persist();
    return updated;
  }

  delete(id) {
    const existed = this._alerts.has(String(id));
    this._alerts.delete(String(id));
    if (existed) this._persist();
    return existed;
  }

  recordTrigger(id) {
    const alert = this._alerts.get(String(id));
    if (!alert) return;
    alert.lastTriggeredAt = new Date().toISOString();
    alert.updatedAt = alert.lastTriggeredAt;
    if (alert.cooldownMode === 'once') alert.enabled = false;
    this._persist();
  }
}

export const alertStore = new AlertStore();
