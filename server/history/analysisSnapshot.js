import mongoose from 'mongoose';

const AnalysisSnapshotSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, index: true, uppercase: true, trim: true },
    timeframe: { type: String, required: true, trim: true },
    alphaSignals: { type: Array, default: [] },
    patternSignals: { type: Array, default: [] },
    strategyCandidates: { type: Array, default: [] },
    quantFeatures: { type: Array, default: [] },
    qualityScores: { type: Array, default: [] },
    rankedSignals: { type: Array, default: [] },
    warnings: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  {
    versionKey: false,
  },
);

AnalysisSnapshotSchema.set('toJSON', {
  transform: (_doc, ret) => ({
    id: String(ret._id),
    symbol: ret.symbol,
    timeframe: ret.timeframe,
    alphaSignals: Array.isArray(ret.alphaSignals) ? ret.alphaSignals : [],
    patternSignals: Array.isArray(ret.patternSignals) ? ret.patternSignals : [],
    strategyCandidates: Array.isArray(ret.strategyCandidates) ? ret.strategyCandidates : [],
    quantFeatures: Array.isArray(ret.quantFeatures) ? ret.quantFeatures : [],
    qualityScores: Array.isArray(ret.qualityScores) ? ret.qualityScores : [],
    rankedSignals: Array.isArray(ret.rankedSignals) ? ret.rankedSignals : [],
    warnings: Array.isArray(ret.warnings) ? ret.warnings : [],
    createdAt: ret.createdAt,
  }),
});

export const AnalysisSnapshot =
  mongoose.models.AnalysisSnapshot || mongoose.model('AnalysisSnapshot', AnalysisSnapshotSchema);
