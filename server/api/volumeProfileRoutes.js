import { Router } from 'express';
import { chartDataEngine } from '../charting/chartDataEngine.js';
import { filterCandlesByMode, buildVolumeProfile } from '../charting/volumeProfileEngine.js';

const router = Router();

// GET /api/volume-profile/:symbol
router.get('/:symbol', async (req, res) => {
  try {
    const symbol    = String(req.params.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol required' });

    const mode      = String(req.query.mode      || 'visible_range');
    const bins      = Math.min(200, Math.max(5, parseInt(req.query.bins,      10) || 50));
    const timeframe = String(req.query.timeframe || '1m');
    const limit     = Math.min(500, Math.max(10, parseInt(req.query.limit,    10) || 200));

    console.log('[VP route] request', { symbol, mode, bins, timeframe, limit });

    const payload  = await chartDataEngine.getCandles(symbol, timeframe, limit);
    const candles  = payload.candles || [];

    console.log('[VP route] candles before filter', candles.length);

    const filtered = filterCandlesByMode(candles, mode);

    console.log('[VP route] candles after filter', filtered.length);

    const { profile, poc, vah, val, hvn, lvn } = buildVolumeProfile(filtered, bins);

    console.log('[VP route] profile length', profile.length, { poc, vah, val });

    return res.json({
      success:  true,
      symbol,
      timeframe,
      mode,
      bins,
      source:   payload.source || 'unknown',
      profile,
      poc,
      vah,
      val,
      hvn,
      lvn,
      warnings: payload.warnings || [],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
