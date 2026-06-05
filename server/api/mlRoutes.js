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
import { spawn }         from 'node:child_process';
import { readFile }      from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID }    from 'node:crypto';

import { pythonInference, InferenceWorkerError, InferenceTimeoutError }
                                               from './pythonInference.js';
import { validateRequestBody, SchemaError }    from '../ml/mlInferSchema.js';
import { logger as _log }                      from '../observability/logger.js';

const log = _log.child({ component: 'mlRoutes' });

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename  = fileURLToPath(import.meta.url);
const __dirname   = dirname(__filename);

const MODELS_DIR     = resolve(__dirname, '..', 'ai', 'models');
const MODEL_METADATA = resolve(MODELS_DIR, 'model_metadata.json');
const TRAIN_SCRIPT   = resolve(__dirname, '..', 'ai', 'training', 'train_pipeline.py');

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

  const { features, timeframe } = req.body;

  log.info('infer request', {
    symbol,
    timeframe:    timeframe || null,
    featureCount: Object.keys(features).length,
  });

  // Load model metadata for feature alignment and label mapping
  let meta;
  try {
    const raw = await readFile(MODEL_METADATA, 'utf-8');
    meta = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(200).json({
        ok:      false,
        status:  'no_champion_model',
        message: 'No champion model available. Train and promote a model first.',
      });
    }
    log.error('model metadata read error', { symbol, error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to read model metadata', code: 'MODEL_READ_ERROR' });
  }

  const featureNames = Array.isArray(meta.feature_names) ? meta.feature_names : [];
  const invLabelMap  = (meta.inv_label_map && typeof meta.inv_label_map === 'object')
    ? meta.inv_label_map
    : { '0': 'SHORT', '1': 'NEUTRAL', '2': 'LONG' };

  try {
    const result = await pythonInference.infer({ features, featureNames, invLabelMap });

    return res.json({
      ok:            true,
      symbol,
      timeframe:     timeframe || '1m',
      prediction:    result.signal,   // signal → prediction for API compat
      confidence:    result.confidence,
      probabilities: result.probabilities,
      modelId:       meta.best_model    || 'unknown',
      modelType:     meta.best_model    || 'unknown',
      championSince: meta.trained_at    || null,
      latencyMs:     result.latencyMs,
      inferredAt:    new Date().toISOString(),
    });
  } catch (err) {
    if (err instanceof InferenceTimeoutError) {
      log.warn('inference timeout', { symbol, timeoutMs: err.timeoutMs });
      return res.status(504).json({
        ok:    false,
        error: err.message,
        code:  'TIMEOUT',
        details: { timeoutMs: err.timeoutMs },
      });
    }
    if (err instanceof InferenceWorkerError) {
      const status = _workerErrorToStatus(err.code);
      log.warn('inference worker error', { symbol, code: err.code, message: err.message });
      return res.status(status).json({
        ok:    false,
        error: err.message,
        code:  err.code,
      });
    }
    log.error('unexpected inference error', { symbol, error: err.message });
    return res.status(500).json({ ok: false, error: 'Internal inference error', code: 'INTERNAL_ERROR' });
  }
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
  return res.json({
    ok:            true,   // always true — the route is reachable; workerAlive indicates Python state
    service:       'ml-inference-worker',
    workerAlive:   Boolean(health.workerAlive),
    pid:           health.pid           ?? null,
    restarts:      health.restarts      ?? 0,
    totalRequests: health.totalRequests ?? 0,
    errors:        health.errors        ?? 0,
    modelVersion:  health.modelVersion  ?? null,
    pendingCount:  health.pendingCount  ?? 0,
  });
});

// ── GET /api/ml/model ─────────────────────────────────────────────────────────
//
// Returns model_metadata.json for the champion model, or null if not trained.

mlRoutes.get('/model', async (_req, res) => {
  try {
    const raw      = await readFile(MODEL_METADATA, 'utf-8');
    const metadata = JSON.parse(raw);
    return res.status(200).json({
      ok:          true,
      metadata,
      champion:    metadata,   // alias — some frontend variants read data.champion
      challengers: [],
      status:      'model_loaded',
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(200).json({
        ok:          true,
        metadata:    null,
        champion:    null,
        challengers: [],
        status:      'no_model',
        message:     'No champion model trained yet',
      });
    }
    log.error('model metadata read error', { error: err.message });
    return res.status(500).json({
      ok:    false,
      error: 'Failed to read model metadata',
      code:  'MODEL_READ_ERROR',
    });
  }
});

// ── POST /api/ml/train ────────────────────────────────────────────────────────
//
// Spawn a background Python training run. Returns immediately with a jobId.

mlRoutes.post('/train', (req, res) => {
  const { valid, errors } = _validateTrainBody(req.body);
  if (!valid) {
    return res.status(400).json({ ok: false, error: errors.join('; '), code: 'INVALID_INPUT', errors });
  }

  const symbol    = String(req.body.symbol).toUpperCase().trim();
  const horizon   = req.body.horizon  !== undefined ? Number(req.body.horizon)  : 20;
  const tauUp     = req.body.tauUp    !== undefined ? Number(req.body.tauUp)    : 0.005;
  const tauDown   = req.body.tauDown  !== undefined ? Number(req.body.tauDown)  : -0.005;
  const jobId     = randomUUID();
  const startedAt = new Date().toISOString();

  const args = [
    TRAIN_SCRIPT,
    '--symbol',         symbol,
    '--horizon',        String(horizon),
    '--up-threshold',   String(tauUp),
    '--down-threshold', String(tauDown),
    '--output',         MODELS_DIR,
  ];

  let proc;
  try {
    proc = spawn('python3', args, {
      stdio:    ['ignore', 'pipe', 'pipe'],
      env:      { ...process.env, ML_MODELS_DIR: MODELS_DIR },
      detached: false,
    });
  } catch (spawnErr) {
    log.error('train spawn failed', { symbol, error: spawnErr.message });
    return res.status(500).json({
      ok:    false,
      error: `Failed to start training process: ${spawnErr.message}`,
      code:  'SPAWN_ERROR',
    });
  }

  _trainingJobs.set(jobId, { jobId, symbol, startedAt, pid: proc.pid });

  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log.info(`[train:${jobId}:${symbol}] ${line}`);
    }
  });
  proc.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log.warn(`[train:${jobId}:${symbol}] ${line}`);
    }
  });
  proc.on('exit', (code, signal) => {
    log.info('train job finished', { jobId, symbol, code, signal });
    _trainingJobs.delete(jobId);
  });
  proc.on('error', (err) => {
    log.error('train job error', { jobId, symbol, error: err.message });
    _trainingJobs.delete(jobId);
  });

  log.info('train started', { jobId, symbol, pid: proc.pid, horizon });

  return res.status(200).json({ ok: true, jobId, symbol, message: 'Training started', startedAt });
});

// ── GET /api/ml/predictions ───────────────────────────────────────────────────
//
// Returns recent inference history. The current architecture uses a stateless
// persistent worker; results are not persisted between requests. Returns an
// empty list until a persistence layer is added.

mlRoutes.get('/predictions', (_req, res) => {
  return res.status(200).json({ ok: true, predictions: [], count: 0, total: 0 });
});

// ── GET /api/ml/training-runs (also /model-runs for frontend compat) ──────────
//
// Lists active (in-flight) training jobs.

function _trainingRunsHandler(_req, res) {
  const jobs = Array.from(_trainingJobs.values()).map((j) => ({
    jobId:     j.jobId,
    symbol:    j.symbol,
    startedAt: j.startedAt,
    pid:       j.pid ?? null,
    status:    'running',
  }));
  // activeJobs is the canonical field; runs/models are aliases for frontend compat
  return res.status(200).json({ ok: true, activeJobs: jobs, runs: jobs, models: jobs, count: jobs.length });
}

mlRoutes.get('/training-runs', _trainingRunsHandler);
mlRoutes.get('/model-runs',    _trainingRunsHandler);

// ── GET /api/ml/model-card ────────────────────────────────────────────────────

const MODEL_CARD = resolve(MODELS_DIR, 'model_card.md');

mlRoutes.get('/model-card', async (req, res) => {
  try {
    const content = await readFile(MODEL_CARD, 'utf-8');
    if (req.headers?.accept?.includes('application/json')) {
      return res.status(200).json({ ok: true, content, modelCard: content, status: 'available' });
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    return res.status(200).send(content);
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
    return res.status(500).json({ ok: false, error: 'Failed to read model card', code: 'MODEL_CARD_READ_ERROR' });
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
    return res.status(500).json({ ok: false, error: 'Failed to read feature schema', code: 'SCHEMA_READ_ERROR' });
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
      count:        scores.length,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(200).json({
        ok:       true,
        features: [],
        count:    0,
        status:   'no_champion',
        message:  'No champion model — train a model first',
      });
    }
    log.error('feature-importance read error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to read feature importance', code: 'FEATURE_IMPORTANCE_ERROR' });
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

export default mlRoutes;
