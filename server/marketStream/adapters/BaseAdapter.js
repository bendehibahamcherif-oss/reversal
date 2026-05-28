export class BaseAdapter {
  constructor({ providerId, staleThresholdMs = 120_000 } = {}) {
    this.providerId = String(providerId || 'unknown');
    this.staleThresholdMs = staleThresholdMs;
    this.state = 'disconnected'; // disconnected | connecting | connected | error | stale
    this.subscriptions = new Set();
    this.reconnectCount = 0;
    this.lastTickAt = null;
    this.lastError = null;
    this._listeners = new Map();
  }

  // Lifecycle — subclasses override these
  async connect(_credentials) { this.state = 'connected'; }
  async disconnect() { this.state = 'disconnected'; }
  async subscribe(_symbol, _credentials) {}
  async unsubscribe(symbol) { this.subscriptions.delete(symbol); }

  async reconnect(credentials) {
    this.reconnectCount += 1;
    try { await this.disconnect(); } catch {}
    await this.connect(credentials);
    for (const sym of [...this.subscriptions]) {
      try { await this.subscribe(sym, credentials); } catch {}
    }
  }

  async healthCheck(_credentials) { return this.state === 'connected'; }

  getCapabilities() { return {}; }

  // State helpers
  isStale() {
    if (this.staleThresholdMs === Infinity) return false;
    if (this.state !== 'connected') return false;
    if (!this.lastTickAt) return this.subscriptions.size > 0;
    return (Date.now() - this.lastTickAt) > this.staleThresholdMs;
  }

  getState() {
    return {
      providerId: this.providerId,
      state: this.state,
      subscriptions: Array.from(this.subscriptions),
      reconnectCount: this.reconnectCount,
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      stale: this.isStale(),
      lastError: this.lastError,
    };
  }

  // Event emitter (tick, error, disconnect, reconnect)
  emit(event, data) {
    const cbs = this._listeners.get(event);
    if (cbs) for (const cb of cbs) { try { cb(data); } catch {} }
  }

  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event)?.delete(cb);
  }

  off(event, cb) { this._listeners.get(event)?.delete(cb); }

  _recordTick() { this.lastTickAt = Date.now(); }
}
