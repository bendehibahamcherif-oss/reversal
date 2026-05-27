import mongoose from 'mongoose';

const MarketRegimeSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true, uppercase: true, trim: true },
  timeframe: { type: String, required: true, trim: true },
  regime: { type: String, default: 'unknown', trim: true },
  volatilityLevel: { type: String, default: 'unknown', trim: true },
  trendStrength: { type: Number, default: 0 },
  liquidityCondition: { type: String, default: 'unknown', trim: true },
  confidence: { type: Number, default: 0 },
  reasons: { type: [String], default: [] },
  warnings: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

MarketRegimeSchema.set('toJSON', {
  transform: (_d, ret) => ({
    id: String(ret._id),
    symbol: ret.symbol,
    timeframe: ret.timeframe,
    regime: ret.regime || 'unknown',
    volatilityLevel: ret.volatilityLevel || 'unknown',
    trendStrength: Number(ret.trendStrength || 0),
    liquidityCondition: ret.liquidityCondition || 'unknown',
    confidence: Number(ret.confidence || 0),
    reasons: Array.isArray(ret.reasons) ? ret.reasons : [],
    warnings: Array.isArray(ret.warnings) ? ret.warnings : [],
    createdAt: ret.createdAt,
  }),
});

export const MarketRegime = mongoose.models.MarketRegime || mongoose.model('MarketRegime', MarketRegimeSchema);
