// ── Order Management System Engine ────────────────────────────────────────────
//
// Canonical single source of truth for order lifecycle state.
//
// STATE MACHINE
// ─────────────
//   pending           → submitted, rejected, canceled
//   submitted         → acknowledged, rejected, canceled, filled, partially_filled, error
//   acknowledged      → partially_filled, filled, canceled, rejected, expired, error
//   partially_filled  → filled, canceled, expired, error
//   filled            (terminal)
//   canceled          (terminal)
//   rejected          (terminal)
//   expired           (terminal)
//   error             → submitted (retry), canceled
//
// EVENT TYPES
// ───────────
//   order_created     — order first recorded in OMS
//   submitted         — sent to execution layer / broker
//   acknowledged      — broker confirmed receipt
//   partially_filled  — partial fill received
//   filled            — order fully filled
//   canceled          — canceled by user or system
//   rejected          — rejected by broker or pre-trade check
//   expired           — day order expired
//   reconciled        — OMS state corrected from broker poll
//   error             — unexpected error state
//
// PARENT/CHILD ORDERS
// ───────────────────
//   parentOrderId links children (bracket legs, OCO pair) to a parent.
//   When parent moves to 'canceled' → all OPEN children are cascade-canceled.
//   When parent moves to 'filled'   → children become live (status stays as-is).

import { randomUUID } from 'node:crypto';
import { omsStore } from './omsStore.js';
import { paperTradingEngine } from '../paperTrading/paperTradingEngine.js';
import { ibkrClient } from '../../ibkr/IBGatewayClient.js';
import { wsEmit } from '../websocket/wsEmitter.js';

const OPEN_STATUSES  = new Set(['pending', 'submitted', 'acknowledged', 'partially_filled']);
const TERMINAL_STATUSES = new Set(['filled', 'canceled', 'rejected', 'expired']);

// ── Valid state transitions ───────────────────────────────────────────────────

const TRANSITIONS = {
  pending:          new Set(['submitted', 'rejected', 'canceled']),
  submitted:        new Set(['acknowledged', 'rejected', 'canceled', 'filled', 'partially_filled', 'error']),
  acknowledged:     new Set(['partially_filled', 'filled', 'canceled', 'rejected', 'expired', 'error']),
  partially_filled: new Set(['filled', 'canceled', 'expired', 'error']),
  error:            new Set(['submitted', 'canceled']),
};

function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

// ── ID generators ─────────────────────────────────────────────────────────────

function genOrderId()    { return `oms_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function genEventId()    { return `evt_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function genClientId()   { return `coid_${Date.now()}_${randomUUID().slice(0, 8)}`; }
function genReconId()    { return `recon_${Date.now()}_${randomUUID().slice(0, 8)}`; }

// ── WebSocket OMS event ───────────────────────────────────────────────────────
//
// Event name: 'oms_order_event'
// Payload contract:
// {
//   eventId:        string,
//   orderId:        string,
//   clientOrderId:  string,
//   symbol:         string,
//   side:           string,
//   quantity:       number,
//   eventType:      string,
//   fromStatus:     string|null,
//   toStatus:       string,
//   fillQuantity:   number|null,
//   fillPrice:      number|null,
//   cumulativeFilledQty: number,
//   leavesQty:      number,
//   mode:           'paper'|'live',
//   modeBadge:      'PAPER'|'LIVE',
//   recordedAt:     ISO string,
// }

function _emitEvent(order, event) {
  wsEmit('oms_order_event', {
    eventId:             event.eventId,
    orderId:             order.orderId,
    clientOrderId:       order.clientOrderId,
    symbol:              order.symbol,
    side:                order.side,
    quantity:            order.quantity,
    eventType:           event.eventType,
    fromStatus:          event.fromStatus,
    toStatus:            event.toStatus,
    fillQuantity:        event.fillQuantity    ?? null,
    fillPrice:           event.fillPrice       ?? null,
    cumulativeFilledQty: event.cumulativeFilledQty ?? 0,
    leavesQty:           event.leavesQty       ?? order.quantity,
    mode:                order.mode,
    modeBadge:           order.mode === 'live' ? 'LIVE' : 'PAPER',
    parentOrderId:       order.parentOrderId   ?? null,
    recordedAt:          event.recordedAt,
  });
}

// ── Internal transition helper ────────────────────────────────────────────────

function _applyTransition(order, eventType, toStatus, fields = {}) {
  const now = new Date().toISOString();

  if (TERMINAL_STATUSES.has(order.status)) {
    return { ok: false, error: `Order ${order.orderId} is in terminal state ${order.status}` };
  }

  if (!canTransition(order.status, toStatus)) {
    return { ok: false, error: `Invalid transition ${order.status} → ${toStatus} for order ${order.orderId}` };
  }

  // Compute fill aggregates
  const fillQty   = Number(fields.fillQuantity  || 0);
  const fillPrice = Number(fields.fillPrice      || 0);
  const newFilledQty    = Number(order.filledQuantity) + fillQty;
  const newLeavesQty    = Math.max(0, Number(order.quantity) - newFilledQty);
  const newAvgFillPrice = fillQty > 0
    ? ((Number(order.avgFillPrice || 0) * Number(order.filledQuantity) + fillPrice * fillQty) / newFilledQty)
    : (order.avgFillPrice || null);
  const newCommissions  = Number(order.commissions) + Number(fields.commissions || 0);

  // Timestamp fields
  const timestamps = {};
  if (toStatus === 'submitted'        && !order.submittedAt)   timestamps.submittedAt   = now;
  if (toStatus === 'acknowledged'     && !order.acknowledgedAt) timestamps.acknowledgedAt = now;
  if (toStatus === 'partially_filled' && !order.firstFillAt)   timestamps.firstFillAt   = now;
  if (toStatus === 'filled' || toStatus === 'canceled' || toStatus === 'rejected' || toStatus === 'expired') {
    timestamps.completedAt = now;
    if (toStatus === 'partially_filled' && !order.firstFillAt) timestamps.firstFillAt = now;
  }

  const patch = {
    status:          toStatus,
    filledQuantity:  newFilledQty,
    leavesQuantity:  newLeavesQty,
    avgFillPrice:    newAvgFillPrice ?? null,
    commissions:     newCommissions,
    slippageBps:     fields.slippageBps   ?? order.slippageBps ?? 0,
    rejectionReason: fields.rejectionReason ?? order.rejectionReason ?? null,
    brokerOrderId:   fields.brokerOrderId  ?? order.brokerOrderId   ?? null,
    ...timestamps,
  };

  omsStore.patchOrder(order.orderId, patch);

  const updatedOrder = { ...order, ...patch, updatedAt: now };

  const event = omsStore.appendEvent({
    eventId:              genEventId(),
    orderId:              order.orderId,
    clientOrderId:        order.clientOrderId,
    brokerOrderId:        fields.brokerOrderId ?? order.brokerOrderId ?? null,
    eventType,
    fromStatus:           order.status,
    toStatus,
    fillQuantity:         fillQty  || null,
    fillPrice:            fillPrice || null,
    cumulativeFilledQty:  newFilledQty,
    leavesQty:            newLeavesQty,
    commissions:          fields.commissions || null,
    rejectionReason:      fields.rejectionReason || null,
    brokerTimestamp:      fields.brokerTimestamp || null,
    payload:              fields.payload ? JSON.stringify(fields.payload) : null,
    recordedAt:           now,
  });

  _emitEvent(updatedOrder, event);
  return { ok: true, order: updatedOrder, event };
}

// ── Public OMS API ────────────────────────────────────────────────────────────

export const omsEngine = {
  // ── Create a new order ────────────────────────────────────────────────────

  createOrder(input = {}) {
    const now          = new Date().toISOString();
    const clientOrderId = input.clientOrderId || genClientId();

    // Idempotency: return existing order if clientOrderId already used
    const existing = omsStore.getOrderByClientId(clientOrderId);
    if (existing) {
      return { ok: true, order: existing, idempotent: true, warnings: ['Returning existing OMS order for clientOrderId.'] };
    }

    const order = {
      orderId:         input.orderId     || genOrderId(),
      clientOrderId,
      parentOrderId:   input.parentOrderId   || null,
      brokerOrderId:   input.brokerOrderId   || null,
      symbol:          String(input.symbol   || '').toUpperCase(),
      side:            String(input.side     || 'buy').toLowerCase(),
      type:            String(input.type     || 'market').toLowerCase(),
      quantity:        Number(input.quantity),
      requestedPrice:  input.requestedPrice  ?? null,
      stopPrice:       input.stopPrice       ?? null,
      tif:             input.tif             || 'day',
      status:          'pending',
      filledQuantity:  0,
      leavesQuantity:  Number(input.quantity),
      avgFillPrice:    null,
      commissions:     0,
      slippageBps:     0,
      rejectionReason: null,
      mode:            String(input.mode     || 'paper').toLowerCase(),
      source:          input.source          || 'oms',
      strategyId:      input.strategyId      || null,
      createdAt:       now,
      updatedAt:       now,
      submittedAt:     null,
      acknowledgedAt:  null,
      firstFillAt:     null,
      completedAt:     null,
    };

    omsStore.upsertOrder(order);

    const event = omsStore.appendEvent({
      eventId:              genEventId(),
      orderId:              order.orderId,
      clientOrderId:        order.clientOrderId,
      brokerOrderId:        null,
      eventType:            'order_created',
      fromStatus:           null,
      toStatus:             'pending',
      fillQuantity:         null,
      fillPrice:            null,
      cumulativeFilledQty:  0,
      leavesQty:            order.quantity,
      commissions:          null,
      rejectionReason:      null,
      brokerTimestamp:      null,
      payload:              JSON.stringify({ source: order.source }),
      recordedAt:           now,
    });

    _emitEvent(order, event);
    return { ok: true, order, event };
  },

  // ── State transitions ─────────────────────────────────────────────────────

  submit(orderId, { brokerOrderId } = {}) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };
    return _applyTransition(order, 'submitted', 'submitted', { brokerOrderId });
  },

  acknowledge(orderId, { brokerOrderId } = {}) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };
    return _applyTransition(order, 'acknowledged', 'acknowledged', { brokerOrderId });
  },

  // Record a fill — handles partial and full fills automatically
  fill(orderId, { fillQuantity, fillPrice, commissions = 0, slippageBps = 0, brokerOrderId, brokerTimestamp } = {}) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };

    const qty          = Number(fillQuantity);
    const newFilledQty = Number(order.filledQuantity) + qty;
    const isComplete   = newFilledQty >= Number(order.quantity) - 1e-8;

    const eventType = newFilledQty < Number(order.quantity) - 1e-8 ? 'partially_filled' : 'filled';
    const toStatus  = isComplete ? 'filled' : 'partially_filled';

    // Acknowledge first if still in submitted state
    if (order.status === 'submitted') {
      _applyTransition(order, 'acknowledged', 'acknowledged', { brokerOrderId });
      order.status = 'acknowledged';
    }

    return _applyTransition(
      omsStore.getOrderById(orderId) || order,
      eventType,
      toStatus,
      { fillQuantity: qty, fillPrice, commissions, slippageBps, brokerOrderId, brokerTimestamp },
    );
  },

  cancel(orderId, { reason } = {}) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };
    if (TERMINAL_STATUSES.has(order.status)) {
      return { ok: false, error: `Cannot cancel order in terminal state ${order.status}`, order };
    }

    const result = _applyTransition(order, 'canceled', 'canceled', { rejectionReason: reason || 'User canceled' });
    if (!result.ok) return result;

    // Cascade cancel open children
    const children = omsStore.getChildren(orderId).filter((c) => OPEN_STATUSES.has(c.status));
    for (const child of children) {
      _applyTransition(child, 'canceled', 'canceled', { rejectionReason: 'Parent order canceled (cascade)' });
    }

    return result;
  },

  reject(orderId, { reason, brokerOrderId } = {}) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };
    return _applyTransition(order, 'rejected', 'rejected', { rejectionReason: reason, brokerOrderId });
  },

  expire(orderId) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };
    return _applyTransition(order, 'expired', 'expired', { rejectionReason: 'Order expired' });
  },

  markError(orderId, { reason } = {}) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };
    return _applyTransition(order, 'error', 'error', { rejectionReason: reason });
  },

  // Apply a direct correction from broker data (reconciliation)
  reconcileOrder(orderId, brokerState) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return { ok: false, error: 'Order not found' };

    const now = new Date().toISOString();
    const patch = {
      brokerOrderId:  brokerState.brokerOrderId || order.brokerOrderId,
      status:         brokerState.status,
      filledQuantity: Number(brokerState.filledQuantity ?? order.filledQuantity),
      leavesQuantity: Math.max(0, Number(order.quantity) - Number(brokerState.filledQuantity ?? order.filledQuantity)),
      avgFillPrice:   brokerState.avgFillPrice || order.avgFillPrice,
      completedAt:    TERMINAL_STATUSES.has(brokerState.status) ? (order.completedAt || now) : null,
    };

    omsStore.patchOrder(orderId, patch);
    const updatedOrder = { ...order, ...patch, updatedAt: now };

    const event = omsStore.appendEvent({
      eventId:              genEventId(),
      orderId,
      clientOrderId:        order.clientOrderId,
      brokerOrderId:        brokerState.brokerOrderId || order.brokerOrderId,
      eventType:            'reconciled',
      fromStatus:           order.status,
      toStatus:             brokerState.status,
      fillQuantity:         null,
      fillPrice:            null,
      cumulativeFilledQty:  patch.filledQuantity,
      leavesQty:            patch.leavesQuantity,
      commissions:          null,
      rejectionReason:      brokerState.rejectionReason || null,
      brokerTimestamp:      brokerState.brokerTimestamp || null,
      payload:              JSON.stringify({ source: 'reconciliation', brokerState }),
      recordedAt:           now,
    });

    _emitEvent(updatedOrder, event);
    return { ok: true, order: updatedOrder, event, divergence: order.status !== brokerState.status };
  },

  // ── Reconciliation ───────────────────────────────────────────────────────

  async reconcile(mode = 'paper') {
    const now        = new Date().toISOString();
    const openOrders = omsStore.getOpenOrders(mode);

    const divergences = [];
    let corrections   = 0;

    for (const order of openOrders) {
      try {
        let brokerState = null;

        if (mode === 'paper') {
          // Paper: query paperTradingEngine for the matching order
          const paperOrders = paperTradingEngine.getOrders(order.symbol);
          const paperOrder  = paperOrders.find(
            (o) => o.id === order.brokerOrderId || o.id === order.orderId,
          );
          if (paperOrder) {
            const STATUS_MAP = { filled: 'filled', canceled: 'canceled', pending: 'submitted' };
            brokerState = {
              brokerOrderId:  paperOrder.id,
              status:         STATUS_MAP[paperOrder.status] || paperOrder.status,
              filledQuantity: paperOrder.status === 'filled' ? Number(order.quantity) : Number(order.filledQuantity),
              avgFillPrice:   paperOrder.fillPrice || order.avgFillPrice,
            };
          } else if (order.status === 'submitted' || order.status === 'acknowledged') {
            // Paper order not found in engine — may have been reset; mark as error
            brokerState = { status: 'error', filledQuantity: order.filledQuantity };
          }
        } else if (mode === 'live' && order.brokerOrderId) {
          const ibkrStatus = await ibkrClient.getOrderStatus(order.brokerOrderId);
          if (ibkrStatus && ibkrStatus.status && ibkrStatus.status !== 'unknown') {
            const STATUS_MAP = {
              'Filled':           'filled',
              'Cancelled':        'canceled',
              'Submitted':        'submitted',
              'PreSubmitted':     'submitted',
              'ApiPending':       'pending',
              'Inactive':         'expired',
            };
            brokerState = {
              brokerOrderId:  order.brokerOrderId,
              status:         STATUS_MAP[ibkrStatus.status] || order.status,
              filledQuantity: Number(ibkrStatus.fillQuantity ?? order.filledQuantity),
              avgFillPrice:   ibkrStatus.fillPrice || order.avgFillPrice,
              brokerTimestamp: now,
            };
          }
        }

        if (!brokerState) continue;

        const hasDivergence = brokerState.status !== order.status
          || Math.abs(Number(brokerState.filledQuantity) - Number(order.filledQuantity)) > 1e-6;

        if (hasDivergence) {
          divergences.push({
            orderId:       order.orderId,
            clientOrderId: order.clientOrderId,
            symbol:        order.symbol,
            omsStatus:     order.status,
            brokerStatus:  brokerState.status,
            omsFilledQty:  order.filledQuantity,
            brokerFilledQty: brokerState.filledQuantity,
            divergenceType: brokerState.status !== order.status ? 'status_mismatch' : 'quantity_mismatch',
          });
          this.reconcileOrder(order.orderId, brokerState);
          corrections++;
        }
      } catch (err) {
        divergences.push({
          orderId:       order.orderId,
          clientOrderId: order.clientOrderId,
          divergenceType: 'reconciliation_error',
          error:         err.message,
        });
      }
    }

    const runResult = omsStore.saveReconciliationRun({
      runId:          genReconId(),
      ranAt:          now,
      mode,
      ordersChecked:  openOrders.length,
      divergences:    divergences.length,
      corrections,
      details:        divergences,
    });

    wsEmit('oms_reconciliation_complete', {
      runId:          runResult.runId,
      ranAt:          now,
      mode,
      ordersChecked:  openOrders.length,
      divergences:    divergences.length,
      corrections,
    });

    return {
      ok:             true,
      runId:          runResult.runId,
      mode,
      ordersChecked:  openOrders.length,
      divergences:    divergences.length,
      corrections,
      divergenceDetails: divergences,
    };
  },

  // ── Query helpers ─────────────────────────────────────────────────────────

  getOrder(orderId) {
    return omsStore.getOrderById(orderId);
  },

  getOrderByClientId(clientOrderId) {
    return omsStore.getOrderByClientId(clientOrderId);
  },

  getOrders(params = {}) {
    return omsStore.getOrders(params);
  },

  getOpenOrders(mode) {
    return omsStore.getOpenOrders(mode);
  },

  getOrderWithEvents(orderId) {
    const order = omsStore.getOrderById(orderId);
    if (!order) return null;
    return { ...order, events: omsStore.getEvents(orderId) };
  },

  getChildren(parentOrderId) {
    return omsStore.getChildren(parentOrderId);
  },

  getRecentEvents(limit = 50) {
    return omsStore.getRecentEvents(limit);
  },

  getReconciliationRuns(limit = 20) {
    return omsStore.getReconciliationRuns(limit);
  },

  // ── Statistics ────────────────────────────────────────────────────────────

  getStats(mode) {
    const all = omsStore.getOrders({ mode, limit: 1000 });
    const byStatus = {};
    for (const o of all) {
      byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    }
    const filled   = byStatus.filled   || 0;
    const rejected = byStatus.rejected || 0;
    const canceled = byStatus.canceled || 0;
    const total    = all.length;
    const fillRate = total > 0 ? ((filled / total) * 100).toFixed(2) : '0.00';
    return { total, byStatus, fillRate: Number(fillRate), mode: mode || 'all' };
  },
};
