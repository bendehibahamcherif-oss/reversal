import { Router }    from 'express';
import { mlWorkerPool }    from '../ml/mlWorkerPool.js';
import { InferenceError, HARD_TIMEOUT_MS } from '../ml/inferenceWorker.js';
import { validateRequestBody, SchemaError } from '../ml/mlInferSchema.js';
import { modelRegistryService } from '../ai/registry/modelRegistryService.js';
import { logger as _log }  from '../observability/logger.js';

const log      = _log.child({ component: 'mlRoutes' });
const mlRoutes = Router();

// ── POST /api/ml/infer/:symbol ─────────────────────────────────────────────
//
// Run inference for a symbol using its champion model (or an explicit modelId).
//
// Request body:
//   {
//     features:  Record<string, number>   // required, named feature map
//     timeframe: string                   // optional, e.g. "1m"
//     modelId:   string                   // optional, override champion lookup
//   }
//
// Response 200:
//   { ok, symbol, timeframe, prediction, confidence, probabilities,
//     modelId, modelType, championSince, latencyMs, inferredAt }
//
// Errors:
//   400  INVALID_INPUT      — body fails schema validation
//   422  NO_CHAMPION        — no champion model registered for symbol
//   422  ARTIFACT_NOT_FOUND — artifact file missing (retrain required)
//   504  TIMEOUT            — Python exceeded 400 ms hard limit
//   502  SCHEMA_ERROR       — Python returned unexpected output shape
//   502  PYTHON_ERROR       — Python exited non-zero
//   503  SPAWN_ERROR        — Cannot fork python3 binary

mlRoutes.post('/infer/:symbol', async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();

  // Schema validation
  try {
    validateRequestBody(req.body);
  } catch (err) {
    if (err instanceof SchemaError) {
      return res.status(400).json({
        ok:     false,
        error:  err.message,
        errors: err.errors,
        code:   'INVALID_INPUT',
      });
    }
    throw err;
  }

  const { features, timeframe, modelId } = req.body;

  log.info('infer request', {
    symbol,
    timeframe:    timeframe || null,
    modelId:      modelId   || 'champion',
    featureCount: Object.keys(features).length,
  });

  try {
    const result = await mlWorkerPool.infer(symbol, features, { modelId });

    return res.json({
      ok:           true,
      symbol,
      timeframe:    timeframe || '1m',
      prediction:   result.prediction,
      confidence:   result.confidence,
      probabilities: result.probabilities,
      modelId:      result.modelId,
      modelType:    result.modelType,
      championSince: result.championSince,
      latencyMs:    result.latencyMs,
      inferredAt:   result.inferredAt,
    });
  } catch (err) {
    if (err instanceof InferenceError) {
      const status = _codeToStatus(err.code);
      log.warn('inference error', {
        symbol, code: err.code, message: err.message, ...err.details,
      });
      return res.status(status).json({
        ok:      false,
        error:   err.message,
        code:    err.code,
        details: err.details,
      });
    }
    log.error('unexpected inference error', { symbol, error: err.message });
    return res.status(500).json({ ok: false, error: 'Internal inference error', code: 'INTERNAL_ERROR' });
  }
});

// ── GET /api/ml/health ─────────────────────────────────────────────────────
//
// Returns worker health: champion count, pool stats, timeout config.

mlRoutes.get('/health', (_req, res) => {
  const pool     = mlWorkerPool.getStats();
  const all      = modelRegistryService.list();
  const champions = all.filter((m) => m.status === 'champion');

  return res.json({
    ok:             true,
    service:        'ml-inference-worker',
    hardTimeoutMs:  HARD_TIMEOUT_MS,
    pythonBin:      pool.pythonBin,
    champions:      champions.length,
    championSymbols: champions.map((m) => m.symbol),
    pool,
    note: pool.poolType === 'single-process'
      ? 'Single-process mode — set ML_WORKER_POOL_SIZE and swap to piscina for pool'
      : 'Worker pool active',
  });
});

// ── HTTP status mapping ────────────────────────────────────────────────────

function _codeToStatus(code) {
  switch (code) {
    case 'NO_CHAMPION':        return 422;
    case 'ARTIFACT_NOT_FOUND': return 422;
    case 'TIMEOUT':            return 504;
    case 'SCHEMA_ERROR':       return 502;
    case 'PARSE_ERROR':        return 502;
    case 'PYTHON_ERROR':       return 502;
    case 'SPAWN_ERROR':        return 503;
    case 'STDIN_ERROR':        return 503;
    default:                   return 500;
  }
}

export default mlRoutes;
