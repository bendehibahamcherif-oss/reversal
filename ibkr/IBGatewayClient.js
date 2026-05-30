// ── IBKR Client Portal API Gateway Client ─────────────────────────────────────
//
// Implements the broker adapter contract for Interactive Brokers via the
// Client Portal Web API (REST/JSON, no legacy socket protocol).
//
// Live go-live gate: guarded externally by executionEngine — this client
// provides correct connectivity but will only be reachable when both
// LIVE_EXECUTION_ENABLED=true AND IBKR_PHASE12_OMS_READY=true are set.
//
// Default gateway endpoint: https://localhost:5000/v1/api
// (IBKR Client Portal runs locally on the trading machine.)

import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const DEFAULT_HOST    = process.env.IBKR_GATEWAY_HOST || 'localhost';
const DEFAULT_PORT    = Number(process.env.IBKR_GATEWAY_PORT) || 5000;
const REQUEST_TIMEOUT = 10_000;

// ── Broker adapter contract ───────────────────────────────────────────────────
//
// Any broker adapter used by executionEngine must implement:
//   connect()                → { connected, source, ... }
//   disconnect()             → { connected: false }
//   isConnected()            → boolean
//   getAccount()             → { accountId, broker, accountType, connected, netLiquidation? }
//   getPositions()           → [{ symbol, quantity, averagePrice, ... }]
//   placeOrder(order)        → { brokerOrderId, status, order, ... }
//   cancelOrder(brokerOrderId) → { canceled, brokerOrderId }
//   getOrderStatus(brokerOrderId) → { status, fillPrice?, fillQuantity?, ... }
//   healthCheck()            → boolean
//
// All methods must be safe to call when disconnected and return a structured
// error rather than throwing, so the execution engine can surface them cleanly.

export class IBGatewayClient {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, clientId = 1 } = {}) {
    this.host     = host;
    this.port     = port;
    this.clientId = clientId;
    this._connected = false;
    this._accountId = null;
    this._sessionToken = null;
  }

  // ── Internal HTTP helper ──────────────────────────────────────────────────

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const useHttps = this.port === 5000 || process.env.IBKR_GATEWAY_HTTPS === 'true';
      const options = {
        hostname: this.host,
        port:     this.port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'reversal-proxy/1.0' },
        timeout: REQUEST_TIMEOUT,
        // Self-signed cert is standard for local IB gateway
        rejectUnauthorized: false,
      };

      const req = (useHttps ? https : http).request(options, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf-8');
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
          } catch {
            reject(new Error(`IBKR gateway returned non-JSON (${res.statusCode})`));
          }
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('IBKR gateway request timed out')); });
      req.on('error',  (err) => reject(err));

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ── Connection management ─────────────────────────────────────────────────

  async connect() {
    try {
      const { status, body } = await this._request('POST', '/v1/api/iserver/auth/status');
      if (status === 200 && body?.authenticated) {
        this._connected  = true;
        this._accountId  = body?.selectedAccount || null;
        return { connected: true, source: 'ibkr', accountId: this._accountId, host: this.host, port: this.port };
      }
      // Gateway responded but session not authenticated
      this._connected = false;
      return { connected: false, source: 'ibkr', reason: 'Gateway not authenticated — log in via Client Portal', host: this.host, port: this.port };
    } catch (err) {
      this._connected = false;
      return { connected: false, source: 'ibkr', reason: `Gateway unreachable: ${err.message}`, host: this.host, port: this.port };
    }
  }

  async disconnect() {
    try { await this._request('POST', '/v1/api/logout'); } catch { /* best-effort */ }
    this._connected = false;
    return { connected: false, source: 'ibkr' };
  }

  isConnected() { return this._connected; }

  async healthCheck() {
    try {
      const { status } = await this._request('GET', '/v1/api/iserver/auth/status');
      return status === 200;
    } catch { return false; }
  }

  // ── Account info ──────────────────────────────────────────────────────────

  async getAccount() {
    if (!this._connected) {
      return { connected: false, source: 'ibkr', error: 'Not connected to IBKR gateway' };
    }
    try {
      const { body } = await this._request('GET', '/v1/api/portfolio/accounts');
      const acc = Array.isArray(body) ? body[0] : body;
      return {
        accountId:       acc?.id || this._accountId,
        broker:          'IBKR',
        accountType:     acc?.type || 'UNKNOWN',
        currency:        acc?.currency || 'USD',
        connected:       true,
        source:          'ibkr',
      };
    } catch (err) {
      return { connected: true, source: 'ibkr', error: err.message };
    }
  }

  // ── Positions ─────────────────────────────────────────────────────────────

  async getPositions() {
    if (!this._connected) return [];
    try {
      const accountId = this._accountId || 'U0000000';
      const { body }  = await this._request('GET', `/v1/api/portfolio/${accountId}/positions/0`);
      if (!Array.isArray(body)) return [];
      return body.map((p) => ({
        symbol:       p.contractDesc || p.ticker || '',
        quantity:     Number(p.position || 0),
        averagePrice: Number(p.avgCost || 0),
        marketPrice:  Number(p.mktPrice || 0),
        unrealizedPnL: Number(p.unrealizedPnl || 0),
        source:       'ibkr',
      }));
    } catch { return []; }
  }

  // ── Order placement ───────────────────────────────────────────────────────

  async placeOrder(order = {}) {
    if (!this._connected) {
      return { success: false, source: 'ibkr', error: 'Not connected to IBKR gateway' };
    }
    try {
      const accountId = this._accountId || 'U0000000';
      const ibkrOrder = {
        acctId:      accountId,
        conid:       order.conid || 0,         // contract ID — must be resolved before calling
        orderType:   order.type === 'market' ? 'MKT' : 'LMT',
        side:        order.side === 'buy' ? 'BUY' : 'SELL',
        quantity:    order.quantity,
        tif:         'DAY',
        cOID:        order.clientOrderId,       // idempotent client order ID
        ...(order.type === 'limit' ? { price: order.requestedPrice } : {}),
      };

      const { status, body } = await this._request('POST', `/v1/api/iserver/account/${accountId}/orders`, { orders: [ibkrOrder] });

      if (status !== 200 || !body) {
        return { success: false, source: 'ibkr', error: `IBKR returned HTTP ${status}` };
      }

      const result = Array.isArray(body) ? body[0] : body;
      return {
        success:       true,
        source:        'ibkr',
        brokerOrderId: String(result?.orderId || result?.id || randomUUID()),
        status:        result?.order_status || 'Submitted',
        message:       result?.message,
        clientOrderId: order.clientOrderId,
      };
    } catch (err) {
      return { success: false, source: 'ibkr', error: err.message };
    }
  }

  // ── Order status ──────────────────────────────────────────────────────────

  async getOrderStatus(brokerOrderId) {
    if (!this._connected) return { status: 'unknown', source: 'ibkr' };
    try {
      const { body } = await this._request('GET', `/v1/api/iserver/account/order/status/${brokerOrderId}`);
      return {
        brokerOrderId,
        status:        body?.order_status || 'Unknown',
        fillPrice:     body?.avgPrice     || null,
        fillQuantity:  body?.filledQuantity || null,
        source:        'ibkr',
      };
    } catch (err) {
      return { status: 'unknown', source: 'ibkr', error: err.message };
    }
  }

  // ── Order cancellation ────────────────────────────────────────────────────

  async cancelOrder(brokerOrderId) {
    if (!this._connected) {
      return { canceled: false, source: 'ibkr', error: 'Not connected' };
    }
    try {
      const accountId = this._accountId || 'U0000000';
      const { status } = await this._request('DELETE', `/v1/api/iserver/account/${accountId}/order/${brokerOrderId}`);
      return { canceled: status === 200, brokerOrderId, source: 'ibkr' };
    } catch (err) {
      return { canceled: false, source: 'ibkr', error: err.message };
    }
  }
}

export const ibkrClient = new IBGatewayClient();
