import { Router } from 'express';
import { chartDataEngine } from '../charting/chartDataEngine.js';
import { VolumeProfileEngine } from '../charting/VolumeProfileEngine.js';

const router = Router();

// GET /api/volume-profile/:symbol
// Query params: timeframe, bins, mode, start, end, visibleRange
router.get('/:symbol', async (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });

    const timeframe    = String(req.query.timeframe || '1m');
    const bins         = Math.min(200, Math.max(5, parseInt(req.query.bins, 10) || 24));
    const start        = req.query.start  || null;
    const end          = req.query.end    || null;
    const visibleRange = req.query.visibleRange === 'true';
    const mode         = visibleRange ? 'visible_range' : String(req.query.mode || 'visible_range');

    const candleData = await chartDataEngine.getCandles(symbol, timeframe, 400);
    const result     = VolumeProfileEngine.compute(candleData.candles, { mode, bins, start, end });

    return res.json({
      success:     true,
      symbol,
      timeframe,
      source:      candleData.source,
      profile:     result.profile,
      poc:         result.poc,
      vah:         result.vah,
      val:         result.val,
      hvn:         result.hvn,
      lvn:         result.lvn,
      totalVolume: result.totalVolume,
      timestamp:   new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: String(e?.message || e) });
  }
});

export default router;
