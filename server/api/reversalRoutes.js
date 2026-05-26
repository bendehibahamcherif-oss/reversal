import { Router } from 'express';
import { reversalDetectorEngine } from '../reversal/reversalDetectorEngine.js';
import { reversalStrategyBridge } from '../reversal/reversalStrategyBridge.js';

const reversalRoutes = Router();

reversalRoutes.get('/points/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const reversalPoints = reversalDetectorEngine.getReversalPoints(symbol);
  return res.json({ ok: true, symbol, reversalPoints, warnings: reversalPoints.length === 0 ? ['No stored reversal points for symbol.'] : [] });
});

reversalRoutes.post('/detect/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const timeframe = req.body?.timeframe || req.query?.timeframe || '1m';
  const result = reversalDetectorEngine.detectReversals(symbol, timeframe);
  return res.json({ ok: true, ...result });
});


reversalRoutes.post('/strategy/:symbol/:reversalPointId', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const reversalPointId = String(req.params.reversalPointId || '');
    const result = reversalStrategyBridge.createStrategyFromReversal(symbol, reversalPointId);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        symbol,
        strategy: null,
        savedStrategy: null,
        warnings: result.warnings || ['Reversal point not found.'],
      });
    }

    return res.json({
      success: true,
      symbol,
      strategy: result.strategy,
      savedStrategy: null,
      warnings: result.warnings || [],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      symbol: String(req.params.symbol || '').toUpperCase(),
      strategy: null,
      savedStrategy: null,
      warnings: ['Failed to create strategy from reversal point.', String(error?.message || error)],
    });
  }
});

reversalRoutes.post('/save-strategy/:symbol/:reversalPointId', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const reversalPointId = String(req.params.reversalPointId || '');
    const result = await reversalStrategyBridge.saveReversalStrategy(symbol, reversalPointId);

    if (!result.success) {
      return res.status(404).json({
        success: false,
        symbol,
        strategy: result.strategy || null,
        savedStrategy: null,
        warnings: result.warnings || ['Unable to save strategy from reversal point.'],
      });
    }

    return res.json({
      success: true,
      symbol,
      strategy: result.strategy,
      savedStrategy: result.savedStrategy,
      warnings: result.warnings || [],
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      symbol: String(req.params.symbol || '').toUpperCase(),
      strategy: null,
      savedStrategy: null,
      warnings: ['Failed to save strategy from reversal point.', String(error?.message || error)],
    });
  }
});

reversalRoutes.delete('/points/:symbol', (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const result = reversalDetectorEngine.clearReversalPoints(symbol);
  return res.json({ ok: true, ...result });
});

export default reversalRoutes;
