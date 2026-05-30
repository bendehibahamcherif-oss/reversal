// ── Execution Engine ──────────────────────────────────────────────────────────
//
// Central order routing layer. Routes to paper or live (IBKR) based on mode.
//
// Paper/live separation contract:
//   - Default mode is 'paper' for every order
//   - Live mode requires: LIVE_EXECUTION_ENABLED=true AND IBKR_PHASE12_OMS_READY=true
//   - There is NO auto-switch between modes — mode is caller-supplied and
//     validated on every request
//   - Both modes always return responses with an explicit { mode } field
//   - The UI must render a visible badge for the active mode
//
// clientOrderId idempotency:
//   - If clientOrderId is supplied and an order with that ID already exists,
//     the existing order is returned without re-routing (dedup)
//   - clientOrderId is generated as 'exec_{timestamp}_{random8}' when omitted
//
// WebSocket events:
//   Event name: 'order_update'
//   Fired on: submitted, filled, rejected, canceled, error
//   See _emit() for payload contract.

import { randomUUID } from 'node:crypto';
import { paperTradingEngine } from '../paperTrading/paperTradingEngine.js';
import { ibkrClient } from '../../ibkr/IBGatewayClient.js';
import { checkPreTrade, getRiskStatus, canGoLive } from './riskChecker.js';
import { executionStore } from './executionStore.js';
import { wsEmit } from '../websocket/wsEmitter.js';

function genOrderId()       { return `exec_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function genClientOrderId() { return `coid_${Date.now()}_${randomUUID().slice(0, 8)}`; }

// ── WebSocket order_update event ─────────────────────────────────────────────
//
// Payload contract:
// {
//   orderId:         string,
//   clientOrderId:   string,
//   symbol:          string,
//   side:            'buy'|'sell',
//   type:            'market'|'limit',
//   quantity:        number,
//   status:          'submitted'|'acknowledged'|'filled'|'partially_filled'|'canceled'|'rejected',
//   fillPrice:       number|null,
//   fillQuantity:    number|null,
//   avgFillPrice:    number|null,
//   commissions:     number,
//   slippageBps:     number,
//   rejectionReason: string|null,
//   mode:            'paper'|'live',
//   source:          'paper_engine'|'ibkr',
//   modeBadge:       'PAPER'|'LIVE',
//   timestamp:       ISO string,
//   updatedAt:       ISO string,
// }

function _emit(order) {
  wsEmit('order_update', {
    orderId:         order.orderId,
    clientOrderId:   order.clientOrderId,
    symbol:          order.symbol,
    side:            order.side,
    type:            order.type,
    quantity:        order.quantity,
    status:          order.status,
    fillPrice:       order.fillPrice    ?? null,
    fillQuantity:    order.fillQuantity ?? null,
    avgFillPrice:    order.avgFillPrice ?? null,
    commissions:     order.commissions  ?? 0,
    slippageBps:     order.slippageBps  ?? 0,
    rejectionReason: order.rejectionReason ?? null,
    mode:            order.mode,
    source:          order.source,
    modeBadge:       order.mode === 'live' ? 'LIVE' : 'PAPER',
    timestamp:       order.createdAt,
    updatedAt:       order.updatedAt,
  });
}

// ── Paper execution ────────────────────────────────────────────────────────────

async function routeToPaper(execOrder, arrivalPrice) {
  const result = paperTradingEngine.placeOrder({
    symbol:         execOrder.symbol,
    side:           execOrder.side,
    type:           execOrder.type,
    quantity:       execOrder.quantity,
    requestedPrice: execOrder.requestedPrice,
    strategyId:     execOrder.strategyId,
    source:         'execution_engine_paper',
  });

  const now = new Date().toISOString();

  if (!result.success) {
    const updated = {
      ...execOrder,
      status:          'rejected',
      rejectionReason: result.error || 'Paper engine rejected order',
      source:          'paper_engine',
      updatedAt:       now,
    };
    executionStore.saveOrder(updated);
    _emit(updated);
    return { ok: false, order: updated, mode: 'paper', modeBadge: 'PAPER', error: updated.rejectionReason };
  }

  const fill        = result.fill;
  const fillPrice   = fill?.price   ?? result.order?.fillPrice ?? 0;
  const commissions = fill?.commission ?? 0;
  const slippageBps = arrivalPrice > 0
    ? Math.abs(((fillPrice - arrivalPrice) / arrivalPrice) * 10_000)
    : 0;

  const updated = {
    ...execOrder,
    status:          'filled',
    fillPrice,
    fillQuantity:    execOrder.quantity,
    avgFillPrice:    fillPrice,
    commissions,
    slippageBps:     Number(slippageBps.toFixed(4)),
    source:          'paper_engine',
    brokerOrderId:   result.order?.id || null,
    updatedAt:       now,
  };
  executionStore.saveOrder(updated);

  // Persist fill record
  executionStore.saveFill({
    fillId:        `fill_${Date.now()}_${randomUUID().slice(0, 8)}`,
    orderId:       updated.orderId,
    clientOrderId: updated.clientOrderId,
    symbol:        updated.symbol,
    side:          updated.side,
    quantity:      updated.quantity,
    price:         fillPrice,
    commissions,
    slippageBps:   updated.slippageBps,
    mode:          'paper',
    executedAt:    now,
  });

  _emit(updated);
  return { ok: true, order: updated, fill, mode: 'paper', modeBadge: 'PAPER', warnings: result.warning ? [result.warning] : [] };
}

// ── Live (IBKR) execution ──────────────────────────────────────────────────────

async function routeToLive(execOrder) {
  const now = new Date().toISOString();

  if (!ibkrClient.isConnected()) {
    const connResult = await ibkrClient.connect();
    if (!connResult.connected) {
      const updated = {
        ...execOrder,
        status:          'rejected',
        rejectionReason: `IBKR gateway not connected: ${connResult.reason}`,
        source:          'ibkr',
        updatedAt:       now,
      };
      executionStore.saveOrder(updated);
      _emit(updated);
      return { ok: false, order: updated, mode: 'live', modeBadge: 'LIVE', error: updated.rejectionReason };
    }
  }

  const result = await ibkrClient.placeOrder({
    symbol:         execOrder.symbol,
    side:           execOrder.side,
    type:           execOrder.type,
    quantity:       execOrder.quantity,
    requestedPrice: execOrder.requestedPrice,
    clientOrderId:  execOrder.clientOrderId,
  });

  if (!result.success) {
    const updated = {
      ...execOrder,
      status:          'rejected',
      rejectionReason: result.error || 'IBKR rejected order',
      source:          'ibkr',
      updatedAt:       now,
    };
    executionStore.saveOrder(updated);
    _emit(updated);
    return { ok: false, order: updated, mode: 'live', modeBadge: 'LIVE', error: updated.rejectionReason };
  }

  const updated = {
    ...execOrder,
    status:        'acknowledged',
    brokerOrderId: result.brokerOrderId,
    source:        'ibkr',
    updatedAt:     now,
  };
  executionStore.saveOrder(updated);
  _emit(updated);
  return { ok: true, order: updated, mode: 'live', modeBadge: 'LIVE', warnings: [] };
}

// ── Public API ────────────────────────────────────────────────────────────────

export const executionEngine = {
  // Place an order (paper or live)
  async placeOrder(input = {}) {
    const mode = String(input.mode || 'paper').toLowerCase();

    // Idempotency: return existing order if clientOrderId already used
    const clientOrderId = input.clientOrderId
      ? String(input.clientOrderId)
      : genClientOrderId();

    if (input.clientOrderId) {
      const existing = executionStore.getOrderByClientId(clientOrderId);
      if (existing) {
        return { ok: true, order: existing, mode: existing.mode, modeBadge: existing.mode === 'live' ? 'LIVE' : 'PAPER', idempotent: true, warnings: ['Returning existing order for clientOrderId.'] };
      }
    }

    // Pre-trade risk checks
    const risk = await checkPreTrade(input, mode);
    const now  = new Date().toISOString();

    if (!risk.allowed) {
      const orderId = genOrderId();
      const rejected = {
        orderId,
        clientOrderId,
        symbol:          String(input.symbol || '').toUpperCase(),
        side:            String(input.side || 'buy').toLowerCase(),
        type:            String(input.type || 'market').toLowerCase(),
        quantity:        Number(input.quantity) || 0,
        requestedPrice:  input.requestedPrice ?? null,
        status:          'rejected',
        fillPrice:       null,
        fillQuantity:    null,
        avgFillPrice:    null,
        commissions:     0,
        slippageBps:     0,
        arrivalPrice:    null,
        rejectionReason: risk.reason,
        mode,
        source:          mode === 'live' ? 'ibkr' : 'paper_engine',
        strategyId:      input.strategyId || null,
        brokerOrderId:   null,
        createdAt:       now,
        updatedAt:       now,
      };
      executionStore.saveOrder(rejected);
      _emit(rejected);
      return { ok: false, mode, modeBadge: mode === 'live' ? 'LIVE' : 'PAPER', order: rejected, error: risk.reason, riskCode: risk.code };
    }

    // Build internal order record
    const execOrder = {
      orderId:         genOrderId(),
      clientOrderId,
      symbol:          String(input.symbol || '').toUpperCase(),
      side:            String(input.side || 'buy').toLowerCase(),
      type:            String(input.type || 'market').toLowerCase(),
      quantity:        Number(input.quantity),
      requestedPrice:  input.requestedPrice ?? null,
      status:          'submitted',
      fillPrice:       null,
      fillQuantity:    null,
      avgFillPrice:    null,
      commissions:     0,
      slippageBps:     0,
      arrivalPrice:    risk.arrivalPrice || null,
      rejectionReason: null,
      mode,
      source:          mode === 'live' ? 'ibkr' : 'paper_engine',
      strategyId:      input.strategyId || null,
      brokerOrderId:   null,
      createdAt:       now,
      updatedAt:       now,
    };

    // Emit 'submitted' event before routing
    executionStore.saveOrder(execOrder);
    _emit(execOrder);

    // Route to paper or live
    if (mode === 'live') {
      return routeToLive(execOrder);
    }
    return routeToPaper(execOrder, risk.arrivalPrice || 0);
  },

  // Cancel an order
  async cancelOrder(orderId) {
    const order = executionStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };

    if (['filled', 'canceled', 'rejected'].includes(order.status)) {
      return { ok: false, error: `Cannot cancel order in ${order.status} state`, order };
    }

    const now = new Date().toISOString();

    if (order.mode === 'live' && order.brokerOrderId) {
      const result = await ibkrClient.cancelOrder(order.brokerOrderId);
      if (!result.canceled) {
        return { ok: false, error: result.error || 'IBKR cancel failed', order };
      }
    }

    executionStore.updateOrderStatus(orderId, { status: 'canceled' });
    const updated = { ...order, status: 'canceled', updatedAt: now };
    _emit(updated);
    return { ok: true, order: updated, mode: order.mode, modeBadge: order.mode === 'live' ? 'LIVE' : 'PAPER' };
  },

  // Query orders
  getOrders(params = {}) {
    return executionStore.getOrders(params);
  },

  getOrderById(orderId) {
    return executionStore.getOrderById(orderId);
  },

  // Query fills
  getFills(params = {}) {
    return executionStore.getFills(params);
  },

  // System status
  getStatus() {
    const risk = getRiskStatus();
    return {
      mode:                 canGoLive() ? 'live' : 'paper',
      modeBadge:            canGoLive() ? 'LIVE' : 'PAPER',
      liveExecutionEnabled: risk.liveExecutionEnabled,
      phase12OMSReady:      risk.phase12OMSReady,
      canGoLive:            risk.canGoLive,
      killSwitch:           risk.killSwitch,
      ibkrConnected:        ibkrClient.isConnected(),
      riskConfig:           risk.config,
    };
  },
};
