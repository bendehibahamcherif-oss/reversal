import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { getCandles } from '../persistence/historicalStore.js';
import { MarketRegime } from './marketRegime.js';

const REGIME_TYPES = ['trend_day', 'range_day', 'mean_reversion', 'gap_and_go', 'volatile_reversal', 'low_liquidity', 'unknown'];

class RegimeEngine {
  constructor() { this.memory = []; }
  isMongoAvailable() { return mongoose.connection?.readyState === 1; }

  detectCurrentRegime(symbol, timeframe = '1m') {
    const candles = getCandles(symbol, timeframe).slice(-120);
    const indicators = this.deriveIndicators(candles);
    return this.classifyRegime(candles, indicators, symbol, timeframe);
  }

  deriveIndicators(candles = []) {
    const c = Array.isArray(candles) ? candles : [];
    const closes = c.map((x) => Number(x.c || 0)).filter((v) => Number.isFinite(v));
    const highs = c.map((x) => Number(x.h || 0));
    const lows = c.map((x) => Number(x.l || 0));
    const volumes = c.map((x) => Number(x.v || 0));
    const open = Number(c[0]?.o || closes[0] || 0);
    const prevClose = Number(c[0]?.pc || open || 0);
    const last = closes[closes.length - 1] || open || 0;
    const avgVolume = volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
    const tr = c.map((x, i) => {
      const h = Number(x.h || 0); const l = Number(x.l || 0);
      const p = i ? Number(c[i - 1]?.c || h) : prevClose;
      return Math.max(h - l, Math.abs(h - p), Math.abs(l - p));
    });
    const atr = tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : 0;
    const vwap = c.reduce((acc, x) => {
      const tp = (Number(x.h || 0) + Number(x.l || 0) + Number(x.c || 0)) / 3;
      const v = Number(x.v || 0);
      acc.pv += tp * v; acc.v += v;
      return acc;
    }, { pv: 0, v: 0 });
    const vwapPrice = vwap.v ? (vwap.pv / vwap.v) : last;
    const emaSlope = closes.length > 20 ? ((closes[closes.length - 1] - closes[closes.length - 21]) / 20) : 0;
    const openingGap = prevClose ? ((open - prevClose) / prevClose) : 0;
    const trendPersistence = closes.length > 2 ? closes.slice(1).filter((v, i) => Math.sign(v - closes[i]) === Math.sign(last - open)).length / (closes.length - 1) : 0;
    const reversalDensity = closes.length > 2 ? closes.slice(2).filter((v, i) => Math.sign(v - closes[i + 1]) !== Math.sign(closes[i + 1] - closes[i])).length / (closes.length - 2) : 0;
    const vwapDistance = last ? ((last - vwapPrice) / last) : 0;
    const volumeProfile = avgVolume > 0 ? (volumes[volumes.length - 1] || 0) / avgVolume : 0;
    const sessionContext = c.length < 30 ? 'opening' : (c.length > 90 ? 'late' : 'mid');
    return { atr, vwapDistance, emaSlope, openingGap, volumeProfile, sessionContext, reversalDensity, trendPersistence, last, open, avgVolume, highs, lows };
  }

  classifyRegime(candles = [], indicators = {}, symbol = '', timeframe = '1m') {
    const warnings = [];
    if (!Array.isArray(candles) || candles.length < 20) warnings.push('Low candle count; regime confidence reduced.');
    const atrRatio = indicators.last ? indicators.atr / indicators.last : 0;
    const range = indicators.highs?.length ? (Math.max(...indicators.highs) - Math.min(...indicators.lows)) : 0;
    const trendStrength = indicators.open ? Math.abs((indicators.last - indicators.open) / indicators.open) : 0;
    const reasons = [];
    let regime = 'unknown';
    let confidence = 0.4;

    if (indicators.avgVolume <= 0 || indicators.volumeProfile < 0.35) {
      regime = 'low_liquidity'; confidence = 0.82; reasons.push('Thin or depressed volume profile indicates weak liquidity condition.');
    } else if (Math.abs(indicators.openingGap) > 0.012 && indicators.trendPersistence > 0.62 && indicators.volumeProfile > 1.15) {
      regime = 'gap_and_go'; confidence = 0.85; reasons.push('Large opening gap with persistent directional follow-through.');
    } else if (atrRatio > 0.012 && indicators.reversalDensity > 0.52) {
      regime = 'volatile_reversal'; confidence = 0.8; reasons.push('Elevated ATR and frequent reversal flips detected.');
    } else if (trendStrength > 0.01 && Math.abs(indicators.emaSlope) > indicators.atr * 0.02 && indicators.trendPersistence > 0.65) {
      regime = 'trend_day'; confidence = 0.78; reasons.push('EMA slope and trend persistence confirm directional pressure.');
    } else if (trendStrength < 0.006 && Math.abs(indicators.vwapDistance) < 0.0025 && indicators.reversalDensity > 0.45) {
      regime = 'mean_reversion'; confidence = 0.72; reasons.push('Price repeatedly mean-reverting around VWAP.');
    } else if (range > 0 && trendStrength < 0.007) {
      regime = 'range_day'; confidence = 0.7; reasons.push('Constrained session range and muted directional drift.');
    }

    const volatilityLevel = atrRatio > 0.012 ? 'high' : (atrRatio > 0.006 ? 'medium' : 'low');
    const liquidityCondition = indicators.volumeProfile < 0.7 ? 'thin' : (indicators.volumeProfile > 1.2 ? 'strong' : 'normal');

    return {
      id: randomUUID(),
      symbol: String(symbol || '').toUpperCase(),
      timeframe: String(timeframe || '1m'),
      regime: REGIME_TYPES.includes(regime) ? regime : 'unknown',
      volatilityLevel,
      trendStrength,
      liquidityCondition,
      confidence,
      reasons,
      warnings,
      createdAt: new Date().toISOString(),
    };
  }

  async saveRegime(regime) {
    if (this.isMongoAvailable()) {
      try { const created = await MarketRegime.create(regime); return created.toJSON(); } catch (err) { console.warn(`RegimeEngine Mongo save failed, using in-memory fallback: ${err.message}`); }
    }
    this.memory.unshift(regime);
    return regime;
  }

  async getRegimeHistory(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (this.isMongoAvailable()) {
      try { return (await MarketRegime.find(s ? { symbol: s } : {}).sort({ createdAt: -1 }).limit(200).lean()).map((x) => ({ id: String(x._id), ...x })); } catch (err) { console.warn(`RegimeEngine Mongo read failed, using in-memory fallback: ${err.message}`); }
    }
    return this.memory.filter((x) => !s || x.symbol === s).slice(0, 200);
  }

  async clearRegimeHistory(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (this.isMongoAvailable()) {
      try { const r = await MarketRegime.deleteMany(s ? { symbol: s } : {}); return { deleted: r.deletedCount || 0 }; } catch (err) { console.warn(`RegimeEngine Mongo clear failed, using in-memory fallback: ${err.message}`); }
    }
    const before = this.memory.length;
    this.memory = s ? this.memory.filter((x) => x.symbol !== s) : [];
    return { deleted: before - this.memory.length };
  }
}

export const regimeEngine = new RegimeEngine();
