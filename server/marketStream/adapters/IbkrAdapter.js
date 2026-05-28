import { BaseAdapter } from './BaseAdapter.js';
import { getCapabilities } from '../CapabilityModel.js';

// IBKR requires a locally-running TWS or IB Gateway.
// This adapter enforces the requirement and stays inactive until a gateway
// URL is configured and reachable.
export class IbkrAdapter extends BaseAdapter {
  constructor() {
    super({ providerId: 'ibkr', staleThresholdMs: 30_000 });
  }

  async connect(credentials) {
    const gatewayUrl = credentials?.gatewayUrl || credentials?.apiKey;
    if (!gatewayUrl) {
      this.state = 'error';
      this.lastError = 'requires_gateway: no gatewayUrl configured';
      return;
    }
    // Real impl: connect to TWS REST API at gatewayUrl (e.g. https://localhost:5000)
    // or IB Client Portal API: POST /v1/api/iserver/auth/status
    this.state = 'error';
    this.lastError = 'gateway_not_implemented: IBKR adapter is a stub';
  }

  async disconnect() { this.state = 'disconnected'; }
  async subscribe(_symbol, _credentials) {}
  async unsubscribe(symbol) { this.subscriptions.delete(symbol); }

  async healthCheck(_credentials) { return false; }

  getCapabilities() { return getCapabilities('ibkr'); }
}
