export class RiskGuard {
  constructor(config = {}) {
    this.config = { maxOrderSize: 1_000, maxPositionSize: 5_000, maxDailyLoss: 10_000, allowShort: false, killSwitchEnabled: false, ...config };
  }
  checkOrder(order = {}, context = {}) {
    if (this.config.killSwitchEnabled) return { allowed: false, reason: 'Kill switch enabled. Paper trading order blocked.' };
    if (Number(order.quantity || 0) <= 0) return { allowed: false, reason: 'Order quantity must be greater than 0.' };
    if (Number(order.quantity) > this.config.maxOrderSize) return { allowed: false, reason: `Order exceeds maxOrderSize (${this.config.maxOrderSize}).` };
    if (!this.config.allowShort && String(order.side).toLowerCase() === 'sell' && Number(context.currentQuantity || 0) < Number(order.quantity)) return { allowed: false, reason: 'Short selling is disabled in paper risk controls.' };
    if (Math.abs(Number(context.projectedQuantity || 0)) > this.config.maxPositionSize) return { allowed: false, reason: `Projected position exceeds maxPositionSize (${this.config.maxPositionSize}).` };
    if (Number(context.dailyRealizedLoss || 0) >= this.config.maxDailyLoss) return { allowed: false, reason: `Daily paper loss limit reached (${this.config.maxDailyLoss}).` };
    return { allowed: true, reason: 'Order approved for paper simulation.' };
  }
  enableKillSwitch() { this.config.killSwitchEnabled = true; return this.getRiskStatus(); }
  disableKillSwitch() { this.config.killSwitchEnabled = false; return this.getRiskStatus(); }
  getRiskStatus() { return { ...this.config, mode: 'paper_trading_only' }; }
}
