import { featureStore } from '../featureStore.js';
import { modelRegistryService } from '../registry/modelRegistryService.js';
import { runInference } from '../mlBridge.js';
import { featureVectorFromRecord } from '../mlCore.js';

// Inference result cache: symbol → { result, timestamp }
const _cache = new Map();
const CACHE_TTL_MS = 30_000;

class InferenceService {
  // ── Deprecated stub (kept for backwards compatibility) ──────────────────────
  prepareInferenceContext(model, featureRow) {
    return { ready: Boolean(model && featureRow), warnings: [] };
  }

  // ── Live inference using champion model ─────────────────────────────────────

  async infer(symbol, timeframe = '1m') {
    const sym = String(symbol || '').toUpperCase();
    const cached = _cache.get(sym);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return { ...cached.result, fromCache: true };
    }

    const champion = modelRegistryService.getChampion(sym);
    if (!champion) {
      return { ok: false, symbol: sym, timeframe, warnings: ['No champion model registered for this symbol.'] };
    }

    const artifactB64 = modelRegistryService.loadArtifact(champion.modelId);
    if (!artifactB64) {
      return { ok: false, symbol: sym, timeframe, modelId: champion.modelId, warnings: ['Model artifact not found on disk. Retrain to restore.'] };
    }

    // Build feature vector from latest feature record
    const records = await featureStore.getFeatureRecords(sym, 1);
    if (!records.length) {
      return { ok: false, symbol: sym, timeframe, modelId: champion.modelId, warnings: ['No feature records available for inference. Run /api/ai/features/save/:symbol first.'] };
    }

    const featureRow = featureVectorFromRecord(records[0]);
    const featureNames = champion.featureSet || [];

    if (!featureNames.length) {
      return { ok: false, symbol: sym, timeframe, modelId: champion.modelId, warnings: ['Champion model has no feature set metadata. Retrain.'] };
    }

    const result = await runInference({
      modelB64:     artifactB64,
      featureRow,
      featureNames,
      labelMap:     champion.labelMap    || {},
      invLabelMap:  champion.invLabelMap || {},
    });

    const response = {
      ok:               true,
      symbol:           sym,
      timeframe,
      modelId:          champion.modelId,
      modelType:        champion.modelType,
      horizon:          champion.horizon,
      prediction:       result.prediction,
      confidence:       result.confidence,
      probabilities:    result.probabilities,
      featureImportance: champion.featureImportance || {},
      championSince:    champion.championSince,
      inferredAt:       new Date().toISOString(),
      warnings:         [],
      fromCache:        false,
    };

    _cache.set(sym, { result: response, timestamp: Date.now() });
    return response;
  }

  clearCache(symbol) {
    if (symbol) _cache.delete(String(symbol).toUpperCase());
    else _cache.clear();
  }
}

export const inferenceService = new InferenceService();
export { InferenceService };
