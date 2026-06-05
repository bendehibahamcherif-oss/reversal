import { Router } from 'express';

const macroRoutes = Router();

function parseSymbols(raw) {
  return raw ? String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined;
}

function parseWindow(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

macroRoutes.get('/correlation', (req, res) => {
  const symbols = parseSymbols(req.query.symbols) || ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'];
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  return res.status(200).json({ ok: true, symbols, matrix: [], timeframe, window, status: 'not_enough_data' });
});

macroRoutes.get('/beta', (req, res) => {
  const asset = String(req.query.asset || req.query.symbol || 'QQQ').toUpperCase();
  const benchmark = String(req.query.benchmark || 'SPY').toUpperCase();
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  return res.status(200).json({ ok: true, asset, benchmark, beta: null, r2: null, timeframe, window, status: 'not_enough_data' });
});

macroRoutes.get('/sector-rotation', (req, res) => {
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  const benchmark = String(req.query.benchmark || 'SPY').toUpperCase();
  return res.status(200).json({ ok: true, sectors: [], benchmark, timeframe, window, status: 'not_enough_data' });
});

macroRoutes.get('/volatility-heatmap', (req, res) => {
  const symbols = parseSymbols(req.query.symbols) || ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'];
  const timeframe = req.query.timeframe || '1d';
  const window = parseWindow(req.query.window) ?? 20;
  return res.status(200).json({ ok: true, symbols, heatmap: [], timeframe, window, status: 'not_enough_data' });
});

macroRoutes.use((req, res) => {
  return res.status(404).json({ ok: false, status: 'not_found', error: 'Macro endpoint not found', endpoint: req.originalUrl || req.path });
});

export default macroRoutes;
