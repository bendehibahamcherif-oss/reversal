import { BaseAdapter } from './BaseAdapter.js';
import { getCapabilities } from '../CapabilityModel.js';

// Polygon WebSocket endpoint: wss://socket.polygon.io/stocks
// Full WS implementation requires @polygon.io/client-js or raw ws.
// This adapter exposes the correct lifecycle interface and will emit ticks
// once real WS credentials are present and the WS library is wired.
export class PolygonAdapter extends BaseAdapter {
  constructor() {
    super({ providerId: 'polygon', staleThresholdMs: 30_000 });
    this._ws = null;
    this._authenticated = false;
  }

  async connect(credentials) {
    if (!credentials?.apiKey) {
      this.state = 'error';
      this.lastError = 'missing_credentials';
      return;
    }
    // Real impl: open wss://socket.polygon.io/stocks and auth with credentials.apiKey
    // Stub: mark as connected so capability model sees credentials are present
    this.state = 'connected';
    this._authenticated = true;
    this.emit('connect', { providerId: 'polygon' });
  }

  async disconnect() {
    if (this._ws) { try { this._ws.close(); } catch {} this._ws = null; }
    this._authenticated = false;
    this.state = 'disconnected';
    this.emit('disconnect', { providerId: 'polygon' });
  }

  async subscribe(symbol, credentials) {
    if (!credentials?.apiKey || !this._authenticated) return;
    this.subscriptions.add(symbol);
    // Real impl: send { action: 'subscribe', params: `T.${symbol}` }
  }

  async unsubscribe(symbol) {
    this.subscriptions.delete(symbol);
    // Real impl: send { action: 'unsubscribe', params: `T.${symbol}` }
  }

  async healthCheck(credentials) {
    return Boolean(credentials?.apiKey) && this.state === 'connected';
  }

  getCapabilities() { return getCapabilities('polygon'); }
}
