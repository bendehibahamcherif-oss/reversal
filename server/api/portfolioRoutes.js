import { Router } from 'express';
import { portfolioEngine } from '../portfolio/portfolioEngine.js';

const portfolioRoutes = Router();

function parseMode(req) {
  return String(req.query.mode || 'paper').toLowerCase();
}

function replyWithEngineResult(res, result) {
  if (result.error && result.code) {
    return res.status(result.code).json({ success: false, error: result.error, mode: result.mode });
  }
  return res.json({ success: true, ...result });
}

// GET /api/portfolio/positions?mode=paper
portfolioRoutes.get('/positions', async (req, res) => {
  try {
    const result = await portfolioEngine.getPositions(parseMode(req));
    return replyWithEngineResult(res, result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/portfolio/summary?mode=paper
portfolioRoutes.get('/summary', async (req, res) => {
  try {
    const result = await portfolioEngine.getSummary(parseMode(req));
    return replyWithEngineResult(res, result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/portfolio/drawdown?mode=paper
portfolioRoutes.get('/drawdown', (req, res) => {
  try {
    const result = portfolioEngine.getDrawdown(parseMode(req));
    return replyWithEngineResult(res, result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/portfolio/var?mode=paper&confidence=0.95&horizon=1
portfolioRoutes.get('/var', async (req, res) => {
  try {
    const confidence = Math.min(0.99, Math.max(0.90, parseFloat(req.query.confidence) || 0.95));
    const horizon    = Math.min(30,   Math.max(1,    parseInt(req.query.horizon, 10)   || 1));
    const result     = await portfolioEngine.getVaR(parseMode(req), confidence, horizon);
    return replyWithEngineResult(res, result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/portfolio/stress-test?mode=paper
// Body: { scenarios: [{ name: string, shocks: { SYMBOL: number } }] }
portfolioRoutes.post('/stress-test', async (req, res) => {
  try {
    const scenarios = Array.isArray(req.body?.scenarios) ? req.body.scenarios : [];
    if (!scenarios.length) {
      return res.status(400).json({ success: false, error: 'scenarios array required' });
    }
    const result = await portfolioEngine.runStressTest(parseMode(req), scenarios);
    return replyWithEngineResult(res, result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default portfolioRoutes;
