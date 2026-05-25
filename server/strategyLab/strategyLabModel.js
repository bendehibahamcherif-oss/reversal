import mongoose from 'mongoose';

const SavedStrategySchema = new mongoose.Schema({
  symbol: { type: String, required: true, index: true },
  name: { type: String, required: true },
  type: { type: String, default: 'candidate' },
  status: { type: String, default: 'draft' },
  direction: { type: String, default: 'neutral' },
  timeframe: { type: String, default: '1m' },
  confidence: { type: Number, default: 0 },
  sourceCandidateId: { type: String, default: '' },
  entryLogic: { type: String, default: '' },
  exitLogic: { type: String, default: '' },
  riskRules: { type: Object, default: {} },
  supportingSignals: { type: Array, default: [] },
  warnings: { type: [String], default: [] },
  tags: { type: [String], default: [] },
  notes: { type: String, default: '' },
  backtestResults: { type: Array, default: [] },
  validationResults: { type: Array, default: [] },
}, {
  timestamps: true,
  versionKey: false,
});

export const SavedStrategy = mongoose.models.SavedStrategy || mongoose.model('SavedStrategy', SavedStrategySchema);
