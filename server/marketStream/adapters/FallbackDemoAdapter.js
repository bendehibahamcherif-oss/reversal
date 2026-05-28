import { BaseAdapter } from './BaseAdapter.js';
import { getCapabilities } from '../CapabilityModel.js';
import { feedManager } from '../../feeds/feedManager.js';

// Demo adapter — never stale, generates synthetic ticks for any symbol.
// Activated only when all real providers are exhausted.
const DEMO_TICK_INTERVAL_MS = 30_000;

export class FallbackDemoAdapter extends BaseAdapter {
  constructor() {
    super({ providerId: 'fallback_demo', staleThresholdMs: Infinity });
    this._timers = new Map();
  }

  async connect(_credentials) {
    this.state = 'connected';
    this.emit('connect', { providerId: 'fallback_demo' });
  }

  async disconnect() {
    for (const sym of [...this.subscriptions]) await this.unsubscribe(sym);
    this.state = 'disconnected';
    this.emit('disconnect', { providerId: 'fallback_demo' });
  }

  async subscribe(symbol, _credentials) {
    if (this.subscriptions.has(symbol)) return;
    this.subscriptions.add(symbol);
    this._generateTick(symbol);
    const timer = setInterval(() => this._generateTick(symbol), DEMO_TICK_INTERVAL_MS);
    this._timers.set(symbol, timer);
  }

  async unsubscribe(symbol) {
    const t = this._timers.get(symbol);
    if (t) { clearInterval(t); this._timers.delete(symbol); }
    this.subscriptions.delete(symbol);
  }

  _generateTick(symbol) {
    try {
      const tick = feedManager.generateDemoTick(symbol);
      if (tick?.price) {
        this._recordTick();
        this.emit('tick', {
          symbol: String(symbol).toUpperCase(),
          provider: 'fallback_demo',
          price: tick.price,
          bid: tick.bid ?? tick.price,
          ask: tick.ask ?? tick.price,
          volume: tick.volume ?? 0,
          timestamp: tick.timestamp ?? new Date().toISOString(),
          source: 'fallback_demo',
          latency: null,
        });
      }
    } catch {}
  }

  async healthCheck(_credentials) { return true; }
  getCapabilities() { return getCapabilities('fallback_demo'); }
}
