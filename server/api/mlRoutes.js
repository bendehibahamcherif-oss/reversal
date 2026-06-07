/**
 * mlRoutes.js
 *
 * Express Router — ML Signal Engine
 *
 * Endpoints
 * ---------
 *   POST /api/ml/infer/:symbol   — inference via mlWorkerPool (Python subprocess)
 *   GET  /api/ml/health          — worker pool health check
 *   GET  /api/ml/model           — champion model metadata (model_metadata.json)
 *   POST /api/ml/train           — start a background training job
 *
 * All endpoints return JSON.
 * Error shape: { ok: false, error: string, code: string }
 */

import { Router }        from 'express';
import { readFile }      from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sanitizeJson } from '../historical/jsonSafety.js';
import { resolveDatasetForTraining } from '../historical/historicalDataService.js';

import { pythonInference, InferenceWorkerError, InferenceTimeoutError }
                                               from './pythonInference.js';
import { validateRequestBody, SchemaError }    from '../ml/mlInferSchema.js';
import { logger as _log }                      from '../observability/logger.js';
import { trainingService, EXPECTED_DATASET_PATHS, getPythonBin, probePythonDependencies } from '../ai/trainingService.js';
import { modelRegistry } from '../ai/modelRegistry.js';

const log = _log.child({ component: 'mlRoutes' });

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);

const MODELS_DIR     = resolve(__dirname, '..', 'ai', 'models');
const MODEL_METADATA = resolve(MODELS_DIR, 'model_metadata.json');

// ── In-memory training job registry ──────────────────────────────────────────

/** @type {Map<string, { jobId: string, symbol: string, startedAt: string, pid: number|undefined }>} */
const _trainingJobs = new Map();

// ── Validation helpers ────────────────────────────────────────────────────────

const SYMBOL_RE = /^[A-Z0-9./^=-]{1,20}$/;

function _validateTrainBody(body) {
  const errors = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    errors.push('Request body must be a JSON object');
    return { valid: false, errors };
  }

  if (!body.symbol || typeof body.symbol !== 'string') {
    errors.push('"symbol" is required and must be a string');
  } else if (!SYMBOL_RE.test(body.symbol.toUpperCase())) {
    errors.push(`"symbol" "${body.symbol}" is invalid (1–20 uppercase alphanumeric + ./^=-)`);
  }

  if (body.horizon !== undefined) {
    const h = Number(body.horizon);
    if (!Number.isInteger(h) || h < 1 || h > 1000) {
      errors.push('"horizon" must be a positive integer between 1 and 1000');
    }
  }

  if (body.tauUp !== undefined && (typeof body.tauUp !== 'number' || !Number.isFinite(body.tauUp))) {
    errors.push('"tauUp" must be a finite number');
  }

  if (body.tauDown !== undefined && (typeof body.tauDown !== 'number' || !Number.isFinite(body.tauDown))) {
    errors.push('"tauDown" must be a finite number');
  }

  return { valid: errors.length === 0, errors };
}

// ── Router ────────────────────────────────────────────────────────────────────

const mlRoutes = Router();

// ── POST /api/ml/infer/:symbol ────────────────────────────────────────────────
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
  const champion = modelRegistry.getChampion(symbol) || modelRegistry.getChampion();

  if (!champion) {
    return res.status(200).json({
      ok:      false,
      status:  'no_champion_model',
      message: 'No champion model available. Train and promote a model first.',
    });
  }

  const featureVector = req.body?.featureVector || req.body?.features || null;
  if (!featureVector || typeof featureVector !== 'object' || Array.isArray(featureVector)) {
    return res.status(200).json({
      ok:      false,
      status:  'feature_vector_required',
      message: 'Champion model exists, but live feature extraction is not wired yet. Provide featureVector.',
      modelId: champion.modelId,
    });
  }

  const manifestPath = resolve(champion.artifactPath || '', 'manifest.json');
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
  } catch {
    return res.status(200).json({
      ok: false,
      status: 'model_artifact_unavailable',
      message: 'Champion model manifest is missing. Retrain or promote a valid model.',
      modelId: champion.modelId,
    });
  }

  const required = Array.isArray(manifest.features) ? manifest.features : [];
  const missing = required.filter((name) => !Number.isFinite(Number(featureVector[name])));
  if (missing.length) {
    return res.status(400).json({
      ok: false,
      status: 'invalid_feature_vector',
      message: 'featureVector is missing required model features.',
      missingFeatures: missing,
      modelId: champion.modelId,
    });
  }

  // Loading and executing arbitrary local model artifacts is intentionally left
  // to the trusted Python inference worker. The first trainable path registers
  // the champion and validates schemas; live feature extraction/worker wiring is
  // reported explicitly instead of crashing or fabricating predictions.
  return res.status(200).json({
    ok: false,
    status: 'inference_worker_not_wired',
    message: 'Champion model and featureVector are valid, but the artifact inference worker is not wired yet.',
    modelId: champion.modelId,
  });
});

// ── GET /api/ml/health ────────────────────────────────────────────────────────
//
// Returns worker health: champion count, pool stats, timeout config.

mlRoutes.get('/health', async (_req, res) => {
  let health;
  try {
    health = await pythonInference.health();
  } catch {
    health = { ok: false, workerAlive: false, pid: null, restarts: 0, totalRequests: 0, errors: 0, modelVersion: null, pendingCount: 0 };
  }
  const workerAlive = Boolean(health.workerAlive);
  const worker = {
    available:     workerAlive,
    mode:          workerAlive ? 'running' : 'not_configured',
    workerAlive,
    pid:           health.pid           ?? null,
    restarts:      health.restarts      ?? 0,
    totalRequests: health.totalRequests ?? 0,
    errors:        health.errors        ?? 0,
    modelVersion:  health.modelVersion  ?? null,
    pendingCount:  health.pendingCount  ?? 0,
  };
  return res.json({
    ok:            true,   // always true — the route is reachable; worker.available indicates Python state
    status:        'available',
    service:       'ml-inference-worker',
    worker,
    workerAlive,
    pid:           worker.pid,
    restarts:      worker.restarts,
    totalRequests: worker.totalRequests,
    errors:        worker.errors,
    modelVersion:  worker.modelVersion,
    pendingCount:  worker.pendingCount,
  });
});

// ── GET /api/ml/model ─────────────────────────────────────────────────────────
//
// Returns model_metadata.json for the champion model, or null if not trained.

mlRoutes.get('/model', async (_req, res) => {
  const champion = modelRegistry.getChampion();
  return res.status(200).json({
    ok: true,
    metadata: champion,
    champion,
    challengers: [],
    status: champion ? 'model_loaded' : 'no_model',
    message: champion ? undefined : 'No champion model trained yet',
  });
});

// ── POST /api/ml/train ────────────────────────────────────────────────────────
//
// Spawn a background Python training run. Returns immediately with a jobId.

mlRoutes.post('/train', async (req, res) => {
  const body = { ...(req.body || {}) };

  log.info('train request received', {
    route: 'POST /api/ml/train',
    symbol: body.symbol,
    timeframe: body.timeframe,
    horizon: body.horizon,
    datasetId: body.datasetId ?? null,
    datasetPath: body.datasetPath ?? null,
  });

  if (String(body.datasetId ?? '').trim().toLowerCase() === 'undefined' || String(body.datasetId ?? '').trim().toLowerCase() === 'null') {
    return res.status(400).json({ ok: false, status: 'dataset_required', message: 'datasetId must be a real dataset id when provided.' });
  }

  // Resolve datasetId → CSV path before handing off to trainingService.
  // train_pipeline.py requires .csv or .parquet — not .json.
  if (body.datasetId && !body.datasetPath) {
    const resolved = resolveDatasetForTraining(String(body.datasetId));
    log.info('dataset resolution', { datasetId: body.datasetId, resolved });

    if (!resolved.ok) {
      const statusMap = {
        dataset_not_found:    { http: 404, status: 'dataset_not_found',   message: 'Historical dataset was selected but was not found in the backend registry.' },
        dataset_file_missing: { http: 404, status: 'dataset_file_missing', message: 'Historical dataset exists in registry but its file does not exist on this server. Re-download the dataset.' },
        dataset_csv_missing:  { http: 422, status: 'dataset_csv_missing',  message: 'Dataset JSON exists but the training-ready CSV was not generated. Re-download the dataset.' },
      };
      const mapped = statusMap[resolved.error] ?? { http: 422, status: resolved.error, message: resolved.detail ?? 'Dataset could not be resolved.' };
      return res.status(mapped.http).json(sanitizeJson({
        ok:        false,
        status:    mapped.status,
        message:   mapped.message,
        datasetId: body.datasetId,
        ...(resolved.candidatePaths ? { candidatePaths: resolved.candidatePaths } : {}),
      }));
    }

    body.datasetPath = resolved.path;
    log.info('dataset resolved to CSV', { datasetId: body.datasetId, csvPath: resolved.path });
  }


  try {
    const result = await trainingService.train(body);
    return res.status(200).json(sanitizeJson(result));
  } catch (err) {
    log.error('train endpoint error', { error: err.message });
    return res.status(500).json(sanitizeJson({
      ok: false,
      status: 'training_failed',
      message: 'Training failed before the worker returned a result.',
      details: { error: err.message },
    }));
  }
});

// ── GET /api/ml/predictions ───────────────────────────────────────────────────
//
// Returns recent inference history. The current architecture uses a stateless
// persistent worker; results are not persisted between requests. Returns an
// empty list until a persistence layer is added.

mlRoutes.get('/predictions', (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : 'SPY';
  return res.status(200).json({ ok: true, predictions: [], symbol, status: 'empty', count: 0, total: 0 });
});

// ── GET /api/ml/training-runs (also /model-runs for frontend compat) ──────────
//
// Lists active (in-flight) training jobs.

function _trainingRunsHandler(req, res) {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : undefined;
  const models = modelRegistry.list();
  return res.status(200).json({
    ok: true,
    activeJobs: [],
    runs: models,
    models,
    status: models.length ? 'available' : 'empty',
    count: models.length,
    ...(symbol ? { symbol } : {}),
  });
}

mlRoutes.get('/training-runs', _trainingRunsHandler);
mlRoutes.get('/model-runs',    _trainingRunsHandler);

mlRoutes.post('/promote/:modelId', (req, res) => {
  const result = modelRegistry.promote(String(req.params.modelId || ''));
  return res.status(result.ok ? 200 : 404).json(result);
});

mlRoutes.get('/dataset/expected-paths', (_req, res) => {
  return res.status(200).json({ ok: true, expectedPaths: EXPECTED_DATASET_PATHS });
});

// ── GET /api/ml/model-card ────────────────────────────────────────────────────

const MODEL_CARD = resolve(MODELS_DIR, 'model_card.md');

mlRoutes.get('/model-card', async (_req, res) => {
  try {
    const content = await readFile(MODEL_CARD, 'utf-8');
    return res.status(200).json({ ok: true, content, modelCard: content, status: 'available' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(200).json({
        ok:        true,
        content:   null,
        modelCard: null,
        status:    'not_available',
        message:   'No model card available yet',
      });
    }
    log.error('model card read error', { error: err.message });
    return res.status(500).json(sanitizeJson({ ok: false, error: 'Failed to read model card', code: 'MODEL_CARD_READ_ERROR' }));
  }
});

// ── GET /api/ml/schema ────────────────────────────────────────────────────────

const FEATURE_SCHEMA_PATH = resolve(MODELS_DIR, 'feature_schema.json');

mlRoutes.get('/schema', async (_req, res) => {
  try {
    const raw    = await readFile(FEATURE_SCHEMA_PATH, 'utf-8');
    const schema = JSON.parse(raw);
    return res.status(200).json({ ok: true, schema });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(200).json({ ok: true, schema: null, message: 'Feature schema not available yet' });
    }
    log.error('feature schema read error', { error: err.message });
    return res.status(500).json(sanitizeJson({ ok: false, error: 'Failed to read feature schema', code: 'SCHEMA_READ_ERROR' }));
  }
});

// ── GET /api/ml/signal/:symbol ────────────────────────────────────────────────
//
// Returns the latest cached inference result for a symbol.
// Since the current architecture is stateless (no inference persistence),
// returns an empty/unavailable state without 404.

mlRoutes.get('/signal/:symbol', (_req, res) => {
  const symbol = String(_req.params.symbol || '').toUpperCase();
  return res.status(200).json({
    ok:          true,
    symbol,
    signal:      null,
    prediction:  null,
    confidence:  null,
    probabilities: null,
    inferredAt:  null,
    status:      'no_cached_signal',
    message:     'No cached signal — run /api/ml/infer/:symbol to generate one',
  });
});

// ── GET /api/ml/feature-importance ───────────────────────────────────────────
//
// Returns feature importance from the champion model's metadata.
// Reads feature_schema.json if present; otherwise returns empty state.

const FEATURE_IMPORTANCE_PATH = resolve(MODELS_DIR, 'feature_schema.json');

mlRoutes.get('/feature-importance', async (req, res) => {
  const modelVersion = req.query.modelVersion || null;
  try {
    const raw    = await readFile(MODEL_METADATA, 'utf-8');
    const meta   = JSON.parse(raw);
    const names  = Array.isArray(meta.feature_names) ? meta.feature_names : [];

    // Try to read importance scores from schema if available
    let scores = [];
    try {
      const schemaRaw = await readFile(FEATURE_IMPORTANCE_PATH, 'utf-8');
      const schema    = JSON.parse(schemaRaw);
      const feats     = Array.isArray(schema.features) ? schema.features : [];
      scores = feats.map((f, i) => ({
        feature:    typeof f === 'object' ? (f.name || f.feature || String(i)) : String(f),
        importance: typeof f === 'object' ? (f.importance ?? 1 / feats.length) : (1 / names.length || 0),
        rank:       i + 1,
      }));
    } catch {
      // No schema file — build from feature_names with equal weights
      scores = names.map((name, i) => ({
        feature:    name,
        importance: names.length ? 1 / names.length : 0,
        rank:       i + 1,
      }));
    }

    return res.status(200).json({
      ok:           true,
      modelId:      meta.best_model    || null,
      modelVersion: modelVersion       || meta.best_model || null,
      trainedAt:    meta.trained_at    || null,
      features:     scores,
      status:       scores.length ? 'available' : 'no_model',
      count:        scores.length,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(200).json({
        ok:       true,
        features: [],
        count:    0,
        status:   'no_model',
        message:  'No champion model — train a model first',
      });
    }
    log.error('feature-importance read error', { error: err.message });
    return res.status(500).json(sanitizeJson({ ok: false, error: 'Failed to read feature importance', code: 'FEATURE_IMPORTANCE_ERROR' }));
  }
});

// ── GET /api/ml/drift ─────────────────────────────────────────────────────────
//
// Returns PSI drift metrics. No live drift engine yet — returns structured
// empty state so the frontend can render "not enough data" without crashing.

mlRoutes.get('/drift', (_req, res) => {
  return res.status(200).json({
    ok:     true,
    drift: {
      status: 'not_enough_data',
      psi: {},
      features: [],
      lastComputedAt: null,
      message: 'Drift monitoring requires at least two inference windows. Run inference on more data.',
    },
  });
});

// ── GET /api/ml/metrics ───────────────────────────────────────────────────────
//
// Composite diagnostics endpoint consumed by MLDiagnosticsPanel.
// Returns worker health + drift stub + empty signal/feature state.

mlRoutes.get('/metrics', async (_req, res) => {
  let health;
  try {
    health = await pythonInference.health();
  } catch {
    health = { ok: false, workerAlive: false, pid: null, restarts: 0, totalRequests: 0, errors: 0, modelVersion: null, pendingCount: 0 };
  }
  const workerStatus = health.workerAlive ? 'running' : 'idle';
  return res.status(200).json({
    ok:     true,
    signal: null,
    drift: {
      status:         'not_enough_data',
      psi:            {},
      features:       [],
      lastComputedAt: null,
    },
    worker: {
      workerAlive:   Boolean(health.workerAlive),
      status:        workerStatus,
      pid:           health.pid           ?? null,
      restarts:      health.restarts      ?? 0,
      totalRequests: health.totalRequests ?? 0,
      errors:        health.errors        ?? 0,
      pendingCount:  health.pendingCount  ?? 0,
    },
    features:    [],
    registry:    null,
    model:       null,
    workerStatus,
  });
});

// ── GET /api/ml/worker/status ─────────────────────────────────────────────────
//
// Python worker status. Mirrors /health but under the path the frontend expects.

mlRoutes.get('/worker/status', async (_req, res) => {
  let health;
  try {
    health = await pythonInference.health();
  } catch {
    health = { ok: false, workerAlive: false, pid: null, restarts: 0, totalRequests: 0, errors: 0, modelVersion: null, pendingCount: 0 };
  }
  return res.status(200).json({
    ok:            true,
    workerAlive:   Boolean(health.workerAlive),
    status:        health.workerAlive ? 'running' : 'idle',
    pid:           health.pid           ?? null,
    restarts:      health.restarts      ?? 0,
    totalRequests: health.totalRequests ?? 0,
    errors:        health.errors        ?? 0,
    modelVersion:  health.modelVersion  ?? null,
    pendingCount:  health.pendingCount  ?? 0,
  });
});

// ── HTTP status mapping ───────────────────────────────────────────────────────

function _workerErrorToStatus(code) {
  switch (code) {
    case 'MAX_RESTARTS_EXCEEDED': return 503;
    case 'SPAWN_ERROR':           return 503;
    case 'STARTUP_TIMEOUT':       return 503;
    case 'STARTUP_FAILED':        return 503;
    case 'STARTUP_EXIT':          return 503;
    case 'SHUTDOWN':              return 503;
    case 'STDIN_ERROR':           return 503;
    case 'WORKER_CRASHED':        return 502;
    case 'WORKER_ERROR':          return 502;
    default:                      return 500;
  }
}

// ── GET /api/ml/dependencies ──────────────────────────────────────────────────
//
// Check Python binary and ML package availability. This route intentionally uses
// the same runtime probe as POST /api/ml/train so a ready dependency response
// cannot disagree with the training preflight.

mlRoutes.get('/dependencies', async (_req, res) => {
  const result = await probePythonDependencies({ pythonBin: getPythonBin() });
  return res.status(200).json(sanitizeJson(result));
});

mlRoutes.use((req, res) => {
  return res.status(404).json({
    ok: false,
    status: 'not_found',
    error: 'ML endpoint not found',
    endpoint: req.originalUrl || req.path,
  });
});

export default mlRoutes;
