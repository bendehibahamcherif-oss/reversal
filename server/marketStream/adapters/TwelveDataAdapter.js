import { BaseAdapter } from './BaseAdapter.js';
import { getCapabilities } from '../CapabilityModel.js';
import { providerRegistry } from '../../feeds/providers/providerRegistry.js';

const POLL_INTERVAL_MS = 60_000;

export class TwelveDataAdapter extends BaseAdapter {
  constructor() {
    super({ providerId: 'twelvedata', staleThresholdMs: 300_000 });
    this._timers = new Map();
    this._credentials = null;
  }

  async connect(credentials) {
    if (!credentials?.apiKey) {
      this.state = 'error';
      this.lastError = 'missing_credentials';
      return;
    }
    this._credentials = credentials;
    this.state = 'connected';
    this.emit('connect', { providerId: 'twelvedata' });
  }

  async disconnect() {
    for (const sym of [...this.subscriptions]) await this.unsubscribe(sym);
    this._credentials = null;
    this.state = 'disconnected';
    this.emit('disconnect', { providerId: 'twelvedata' });
  }

  async subscribe(symbol, credentials) {
    const creds = credentials || this._credentials;
    if (!creds?.apiKey || this.subscriptions.has(symbol)) return;
    this.subscriptions.add(symbol);
    const timer = setInterval(() => this._poll(symbol, creds), POLL_INTERVAL_MS);
    this._timers.set(symbol, timer);
    this._poll(symbol, creds);
  }

  async unsubscribe(symbol) {
    const t = this._timers.get(symbol);
    if (t) { clearInterval(t); this._timers.delete(symbol); }
    this.subscriptions.delete(symbol);
  }

  async _poll(symbol, credentials) {
    const provider = providerRegistry.get('twelvedata');
    if (!provider?.getLatestTick) return;
    try {
      const tick = await provider.getLatestTick(symbol, credentials);
      if (tick?.price) {
        this._recordTick();
        this.emit('tick', {
          symbol: String(symbol).toUpperCase(),
          provider: 'twelvedata',
          price: tick.price,
          bid: tick.bid ?? tick.price,
          ask: tick.ask ?? tick.price,
          volume: tick.volume ?? 0,
          timestamp: tick.timestamp ?? new Date().toISOString(),
          source: 'twelvedata',
          latency: null,
        });
      }
    } catch (e) {
      this.lastError = String(e?.message || e);
    }
  }

  async healthCheck(credentials) {
    const creds = credentials || this._credentials;
    if (!creds?.apiKey) return false;
    try {
      const provider = providerRegistry.get('twelvedata');
      const tick = await provider?.getLatestTick('AAPL', creds);
      return Boolean(tick?.price);
    } catch { return false; }
  }

  getCapabilities() { return getCapabilities('twelvedata'); }
}
