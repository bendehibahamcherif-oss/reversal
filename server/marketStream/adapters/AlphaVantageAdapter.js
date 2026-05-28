import { BaseAdapter } from './BaseAdapter.js';
import { getCapabilities } from '../CapabilityModel.js';
import { providerRegistry } from '../../feeds/providers/providerRegistry.js';

// AlphaVantage has strict rate limits (5 req/min free, 75 req/min premium).
// We poll slowly and only for explicitly subscribed symbols.
const POLL_INTERVAL_MS = 120_000; // 2 minutes to respect free tier limits

export class AlphaVantageAdapter extends BaseAdapter {
  constructor() {
    super({ providerId: 'alphaVantage', staleThresholdMs: 600_000 });
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
    this.emit('connect', { providerId: 'alphaVantage' });
  }

  async disconnect() {
    for (const sym of [...this.subscriptions]) await this.unsubscribe(sym);
    this._credentials = null;
    this.state = 'disconnected';
    this.emit('disconnect', { providerId: 'alphaVantage' });
  }

  async subscribe(symbol, credentials) {
    const creds = credentials || this._credentials;
    if (!creds?.apiKey || this.subscriptions.has(symbol)) return;
    this.subscriptions.add(symbol);
    // AlphaVantage doesn't expose raw ticks — use latest 1m candle close as proxy
    const timer = setInterval(() => this._poll(symbol, creds), POLL_INTERVAL_MS);
    this._timers.set(symbol, timer);
  }

  async unsubscribe(symbol) {
    const t = this._timers.get(symbol);
    if (t) { clearInterval(t); this._timers.delete(symbol); }
    this.subscriptions.delete(symbol);
  }

  async _poll(symbol, credentials) {
    const provider = providerRegistry.get('alphaVantage');
    if (!provider?.getLatestCandle) return;
    try {
      const candle = await provider.getLatestCandle(symbol, '1m', credentials);
      if (candle?.close) {
        this._recordTick();
        this.emit('tick', {
          symbol: String(symbol).toUpperCase(),
          provider: 'alphaVantage',
          price: candle.close,
          bid: candle.close,
          ask: candle.close,
          volume: candle.volume ?? 0,
          timestamp: candle.timestamp ?? new Date().toISOString(),
          source: 'alphaVantage',
          latency: null,
        });
      }
    } catch (e) {
      this.lastError = String(e?.message || e);
    }
  }

  async healthCheck(credentials) {
    return Boolean((credentials || this._credentials)?.apiKey);
  }

  getCapabilities() { return getCapabilities('alphaVantage'); }
}
