import mongoose from 'mongoose';

const DatasetAnalyticsSchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true, uppercase: true, trim: true },
  timeframe: { type: String, required: true, trim: true },
  totalFeatureRecords: { type: Number, default: 0 },
  totalOutcomeLabels: { type: Number, default: 0 },
  labelDistribution: { type: Object, default: {} },
  averageFutureReturn: { type: Number, default: 0 },
  averageMFE: { type: Number, default: 0 },
  averageMAE: { type: Number, default: 0 },
  winRate: { type: Number, default: 0 },
  expectancy: { type: Number, default: 0 },
  regimeBreakdown: { type: Object, default: {} },
  featureStatistics: { type: Object, default: {} },
  warnings: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now, index: true },
}, { versionKey: false });

DatasetAnalyticsSchema.set('toJSON', {
  transform: (_d, ret) => ({
    id: String(ret._id),
    symbol: ret.symbol,
    timeframe: ret.timeframe,
    totalFeatureRecords: Number(ret.totalFeatureRecords || 0),
    totalOutcomeLabels: Number(ret.totalOutcomeLabels || 0),
    labelDistribution: ret.labelDistribution && typeof ret.labelDistribution === 'object' ? ret.labelDistribution : {},
    averageFutureReturn: Number(ret.averageFutureReturn || 0),
    averageMFE: Number(ret.averageMFE || 0),
    averageMAE: Number(ret.averageMAE || 0),
    winRate: Number(ret.winRate || 0),
    expectancy: Number(ret.expectancy || 0),
    regimeBreakdown: ret.regimeBreakdown && typeof ret.regimeBreakdown === 'object' ? ret.regimeBreakdown : {},
    featureStatistics: ret.featureStatistics && typeof ret.featureStatistics === 'object' ? ret.featureStatistics : {},
    warnings: Array.isArray(ret.warnings) ? ret.warnings : [],
    createdAt: ret.createdAt,
  }),
});

export const DatasetAnalytics = mongoose.models.DatasetAnalytics || mongoose.model('DatasetAnalytics', DatasetAnalyticsSchema);
