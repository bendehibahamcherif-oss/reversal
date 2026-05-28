import { BaseAdapter } from './BaseAdapter.js';
import { getCapabilities } from '../CapabilityModel.js';
import { providerRegistry } from '../../feeds/providers/providerRegistry.js';

// Yahoo is delayed/unofficial — poll every 60s as a heartbeat.
// The engine uses this for stale detection and as the guaranteed non-credential fallback.
const POLL_INTERVAL_MS = 60_000;

export class YahooAdapter extends BaseAdapter {
  constructor() {
    super({ providerId: 'yahoo', staleThresholdMs: 180_000 });
    this._timers = new Map();
    this._provider = null;
  }

  async connect(_credentials) {
    this._provider = providerRegistry.get('yahoo');
    this.state = 'connected';
    this.emit('connect', { providerId: 'yahoo' });
  }

  async disconnect() {
    for (const sym of [...this.subscriptions]) await this.unsubscribe(sym);
    this._provider = null;
    this.state = 'disconnected';
    this.emit('disconnect', { providerId: 'yahoo' });
  }

  async subscribe(symbol, _credentials) {
    if (this.subscriptions.has(symbol)) return;
    this.subscriptions.add(symbol);
    // Immediate first poll, then interval
    this._poll(symbol);
    const timer = setInterval(() => this._poll(symbol), POLL_INTERVAL_MS);
    this._timers.set(symbol, timer);
  }

  async unsubscribe(symbol) {
    const t = this._timers.get(symbol);
    if (t) { clearInterval(t); this._timers.delete(symbol); }
    this.subscriptions.delete(symbol);
  }

  async _poll(symbol) {
    if (!this._provider?.getLatestTick) return;
    try {
      const tick = await this._provider.getLatestTick(symbol, {});
      if (tick?.price) {
        this._recordTick();
        this.emit('tick', {
          symbol: String(symbol).toUpperCase(),
          provider: 'yahoo',
          price: tick.price,
          bid: tick.bid ?? tick.price,
          ask: tick.ask ?? tick.price,
          volume: tick.volume ?? 0,
          timestamp: tick.timestamp ?? new Date().toISOString(),
          source: 'yahoo',
          latency: null,
        });
      }
    } catch (e) {
      this.lastError = String(e?.message || e);
    }
  }

  async healthCheck() {
    if (!this._provider?.getLatestTick) return false;
    try {
      const tick = await this._provider.getLatestTick('SPY', {});
      return Boolean(tick?.price);
    } catch { return false; }
  }

  getCapabilities() { return getCapabilities('yahoo'); }
}
