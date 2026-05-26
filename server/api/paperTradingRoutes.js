import { Router } from 'express';
import { paperTradingEngine } from '../paperTrading/paperTradingEngine.js';

const paperTradingRoutes = Router();

paperTradingRoutes.post('/orders', (req, res) => {
  const result = paperTradingEngine.placeOrder(req.body || {});
  res.status(result.success ? 200 : 400).json(result);
});
paperTradingRoutes.get('/orders/:symbol?', (req, res) => {
  res.json({ success: true, mode: 'paper_trading_only', orders: paperTradingEngine.getOrders(req.params.symbol) });
});
paperTradingRoutes.delete('/orders/:orderId', (req, res) => {
  const result = paperTradingEngine.cancelOrder(req.params.orderId);
  res.status(result.success ? 200 : 404).json(result);
});
paperTradingRoutes.get('/fills/:symbol?', (req, res) => {
  res.json({ success: true, mode: 'paper_trading_only', fills: paperTradingEngine.getFills(req.params.symbol) });
});
paperTradingRoutes.get('/positions', (req, res) => {
  res.json({ success: true, mode: 'paper_trading_only', positions: paperTradingEngine.getPositions() });
});
paperTradingRoutes.get('/positions/:symbol', (req, res) => {
  const position = paperTradingEngine.getPosition(req.params.symbol);
  res.status(position ? 200 : 404).json({ success: Boolean(position), mode: 'paper_trading_only', position, error: position ? null : 'Paper position not found.' });
});
paperTradingRoutes.post('/positions/:symbol/close', (req, res) => {
  const result = paperTradingEngine.closePosition(req.params.symbol);
  res.status(result.success ? 200 : 400).json(result);
});
paperTradingRoutes.post('/risk/kill-switch', (_req, res) => {
  res.json({ success: true, mode: 'paper_trading_only', risk: paperTradingEngine.riskGuard.enableKillSwitch() });
});
paperTradingRoutes.delete('/risk/kill-switch', (_req, res) => {
  res.json({ success: true, mode: 'paper_trading_only', risk: paperTradingEngine.riskGuard.disableKillSwitch() });
});
paperTradingRoutes.get('/risk/status', (_req, res) => {
  res.json({ success: true, mode: 'paper_trading_only', risk: paperTradingEngine.riskGuard.getRiskStatus() });
});
paperTradingRoutes.post('/reset', (_req, res) => {
  res.json(paperTradingEngine.resetPaperAccount());
});

export default paperTradingRoutes;
