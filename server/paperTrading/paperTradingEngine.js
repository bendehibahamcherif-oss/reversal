import { getCandlesWithMeta } from '../persistence/historicalStore.js';
import { createPaperFill, createPaperOrder, createPaperPosition } from './models.js';
import { RiskGuard } from './riskGuard.js';

function id(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

export class PaperTradingEngine {
  constructor(config = {}) {
    this.riskGuard = new RiskGuard(config);
    this.orders = [];
    this.fills = [];
    this.positions = new Map();
  }
  resolvePrice(order) {
    if (order.requestedPrice != null) return { price: Number(order.requestedPrice), warning: null };
    const payload = getCandlesWithMeta(order.symbol, '1m');
    const candles = Array.isArray(payload?.candles) ? payload.candles : [];
    const latest = candles[candles.length - 1];
    if (latest?.c != null) return { price: Number(latest.c), warning: payload?.isFallbackDemo ? `Paper fallback pricing used: ${payload.warning}` : null };
    return { price: 100, warning: 'Paper demo price fallback used because no market price exists.' };
  }
  placeOrder(input = {}) {
    const order = createPaperOrder({ ...input, id: id('porder'), status: 'pending', source: 'paper' });
    const currentPos = this.positions.get(order.symbol) || createPaperPosition({ symbol: order.symbol });
    const projectedQuantity = currentPos.quantity + (order.side === 'buy' ? order.quantity : -order.quantity);
    const check = this.riskGuard.checkOrder(order, { currentQuantity: currentPos.quantity, projectedQuantity, dailyRealizedLoss: Math.max(0, -this.totalRealizedPnL()) });
    if (!check.allowed) return { success: false, mode: 'paper_trading_only', error: check.reason, order };
    this.orders.push(order);
    return this.simulateFill(order);
  }
  simulateFill(order) {
    const p = this.resolvePrice(order);
    order.status = 'filled'; order.filledAt = new Date().toISOString(); order.fillPrice = p.price;
    const fill = createPaperFill({ id: id('pfill'), orderId: order.id, symbol: order.symbol, side: order.side, quantity: order.quantity, price: p.price, commission: Number((order.quantity * 0.005).toFixed(4)), slippage: 0, timestamp: order.filledAt });
    this.fills.push(fill); this.applyFillToPosition(fill);
    return { success: true, mode: 'paper_trading_only', order, fill, warning: p.warning };
  }
  applyFillToPosition(fill) {
    const pos = this.positions.get(fill.symbol) || createPaperPosition({ symbol: fill.symbol });
    const signedQty = fill.side === 'buy' ? fill.quantity : -fill.quantity;
    const nextQty = pos.quantity + signedQty;
    const previousQty = pos.quantity;
    if (fill.side === 'buy') {
      const totalCost = (pos.averagePrice * pos.quantity) + (fill.price * fill.quantity);
      pos.quantity = nextQty;
      pos.averagePrice = pos.quantity === 0 ? 0 : Number((totalCost / pos.quantity).toFixed(6));
    } else {
      const closingQty = Math.min(Math.abs(previousQty), fill.quantity);
      pos.realizedPnL += Number(((fill.price - pos.averagePrice) * closingQty).toFixed(6));
      pos.quantity = nextQty;
      if (pos.quantity === 0) pos.averagePrice = 0;
    }
    pos.marketPrice = fill.price;
    pos.unrealizedPnL = Number(((pos.marketPrice - pos.averagePrice) * pos.quantity).toFixed(6));
    pos.updatedAt = new Date().toISOString();
    this.positions.set(fill.symbol, pos);
  }
  totalRealizedPnL() { return Array.from(this.positions.values()).reduce((s, p) => s + Number(p.realizedPnL || 0), 0); }
  getOrders(symbol) { return this.orders.filter((o) => !symbol || o.symbol === String(symbol).toUpperCase()); }
  getFills(symbol) { return this.fills.filter((f) => !symbol || f.symbol === String(symbol).toUpperCase()); }
  getPositions() { return Array.from(this.positions.values()); }
  getPosition(symbol) { return this.positions.get(String(symbol || '').toUpperCase()) || null; }
  closePosition(symbol) {
    const pos = this.getPosition(symbol);
    if (!pos || pos.quantity === 0) return { success: false, mode: 'paper_trading_only', error: 'No open paper position for symbol.' };
    const side = pos.quantity > 0 ? 'sell' : 'buy';
    return this.placeOrder({ symbol: pos.symbol, side, quantity: Math.abs(pos.quantity), type: 'market', source: 'paper_close' });
  }
  cancelOrder(orderId) {
    const order = this.orders.find((o) => o.id === orderId);
    if (!order) return { success: false, mode: 'paper_trading_only', error: 'Paper order not found.' };
    if (order.status === 'filled') return { success: false, mode: 'paper_trading_only', error: 'Filled paper order cannot be canceled.' };
    order.status = 'canceled';
    return { success: true, mode: 'paper_trading_only', order };
  }
  resetPaperAccount() { this.orders = []; this.fills = []; this.positions = new Map(); return { success: true, mode: 'paper_trading_only' }; }
}

export const paperTradingEngine = new PaperTradingEngine();
