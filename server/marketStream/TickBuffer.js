export class TickBuffer {
  constructor({ throttleMs = 250 } = {}) {
    this.throttleMs = throttleMs;
    this._pending = new Map();
    this._lastFlush = new Map();
    this._timers = new Map();
    this._listeners = new Set();
    this._seen = new Map(); // symbol → { price, timestamp } for dedup
  }

  ingest(tick) {
    if (!tick?.symbol) return;
    const sym = String(tick.symbol).toUpperCase();

    // Deduplicate exact same price+timestamp for same symbol
    const prev = this._seen.get(sym);
    if (prev && prev.price === tick.price && prev.timestamp === tick.timestamp) return;
    this._seen.set(sym, { price: tick.price, timestamp: tick.timestamp });

    this._pending.set(sym, { ...tick, symbol: sym });

    if (this._timers.has(sym)) return; // already scheduled

    const lastFlush = this._lastFlush.get(sym) || 0;
    const wait = Math.max(0, this.throttleMs - (Date.now() - lastFlush));
    const timer = setTimeout(() => this._flush(sym), wait);
    this._timers.set(sym, timer);
  }

  _flush(sym) {
    this._timers.delete(sym);
    const tick = this._pending.get(sym);
    if (!tick) return;
    this._pending.delete(sym);
    this._lastFlush.set(sym, Date.now());
    for (const cb of this._listeners) { try { cb(tick); } catch {} }
  }

  onTick(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  destroy() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
    this._listeners.clear();
    this._pending.clear();
    this._seen.clear();
  }

  getStats() {
    return { pending: this._pending.size, throttleMs: this.throttleMs, listeners: this._listeners.size };
  }
}
