// ── ML Inference Worker ────────────────────────────────────────────────────
//
// Node → Python bridge for real-time ML signal inference.
//
// Lifecycle per call:
//   1. Resolve champion (or explicit modelId) from registry
//   2. Load base64 artifact from disk
//   3. Align caller-provided features to champion.featureSet order
//   4. Spawn python3 infer.py, write JSON payload to stdin
//   5. Hard kill + TIMEOUT error if no response within HARD_TIMEOUT_MS
//   6. Validate output schema before resolving
//
// Error codes:
//   NO_CHAMPION        — no champion model registered for the symbol
//   ARTIFACT_NOT_FOUND — model registered but .pkl.b64 file missing on disk
//   TIMEOUT            — Python did not respond within HARD_TIMEOUT_MS
//   SPAWN_ERROR        — could not fork python3 (binary missing or ENOMEM)
//   PYTHON_ERROR       — Python exited non-zero
//   PARSE_ERROR        — Python stdout is not valid JSON
//   SCHEMA_ERROR       — Python JSON does not match expected output shape
//   STDIN_ERROR        — broken pipe writing payload to stdin
//
// Worker-pool migration path (see mlWorkerPool.js):
//   Replace the direct spawn here with a piscina/worker_threads call.
//   This file stays unchanged — the pool owns concurrency, this file owns protocol.

import { spawn }           from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }   from 'node:url';
import { logger as _log }  from '../observability/logger.js';
import { modelRegistryService } from '../ai/registry/modelRegistryService.js';
import { validatePythonOutput, SchemaError } from './mlInferSchema.js';

const log = _log.child({ component: 'inferenceWorker' });

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INFER_SCRIPT = resolve(__dirname, '../ai/ml/infer.py');
const PYTHON_BIN   = process.env.PYTHON_BIN || 'python3';

export const HARD_TIMEOUT_MS = Number(process.env.ML_INFER_TIMEOUT_MS || 400);

// ── Typed error ───────────────────────────────────────────────────────────

export class InferenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name  = 'InferenceError';
    this.code  = code;
    this.details = details;
  }
}

// ── Core worker ───────────────────────────────────────────────────────────

export async function runInferenceWorker({ symbol, features, modelId }) {
  const sym = String(symbol || '').toUpperCase();

  // 1. Resolve model
  const champion = modelId
    ? modelRegistryService.get(modelId)
    : modelRegistryService.getChampion(sym);

  if (!champion) {
    throw new InferenceError('NO_CHAMPION', `No champion model for ${sym}`, { symbol: sym });
  }

  // 2. Load artifact
  const artifactB64 = modelRegistryService.loadArtifact(champion.modelId);
  if (!artifactB64) {
    throw new InferenceError(
      'ARTIFACT_NOT_FOUND',
      `Artifact missing for model ${champion.modelId}`,
      { modelId: champion.modelId },
    );
  }

  // 3. Align features to champion's ordered featureSet (unknown features → 0)
  const featureVector = champion.featureSet.map((name) => {
    const v = features[name];
    return typeof v === 'number' && isFinite(v) ? v : 0;
  });

  // 4. Build strict payload for infer.py
  const payload = {
    model_b64:     artifactB64,
    features:      featureVector,
    feature_names: champion.featureSet,
    inv_label_map: champion.invLabelMap || {},
  };

  const startMs = Date.now();
  log.debug('spawning python infer', {
    symbol: sym,
    modelId: champion.modelId,
    featureCount: featureVector.length,
    timeoutMs: HARD_TIMEOUT_MS,
  });

  // 5. Spawn Python, enforce hard timeout
  return new Promise((resolve, reject) => {
    let settled = false;

    const proc = spawn(PYTHON_BIN, [INFER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      const elapsed = Date.now() - startMs;
      log.warn('inference hard timeout', {
        symbol: sym, modelId: champion.modelId, elapsed, limit: HARD_TIMEOUT_MS,
      });
      reject(new InferenceError('TIMEOUT', `Inference exceeded ${HARD_TIMEOUT_MS}ms hard limit`, {
        elapsed, limit: HARD_TIMEOUT_MS, symbol: sym,
      }));
    }, HARD_TIMEOUT_MS);

    const stdoutBufs = [];
    const stderrBufs = [];
    proc.stdout.on('data', (d) => stdoutBufs.push(d));
    proc.stderr.on('data', (d) => stderrBufs.push(d));

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log.error('python spawn error', { symbol: sym, error: err.message });
      reject(new InferenceError('SPAWN_ERROR', `Cannot spawn ${PYTHON_BIN}: ${err.message}`, {}));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const latencyMs = Date.now() - startMs;
      const raw       = Buffer.concat(stdoutBufs).toString('utf-8').trim();
      const stderr    = Buffer.concat(stderrBufs).toString('utf-8').trim();

      if (code !== 0) {
        log.error('python non-zero exit', { symbol: sym, code, stderr: stderr.slice(0, 300) });
        reject(new InferenceError('PYTHON_ERROR', `Python exited with code ${code}`, {
          code, stderr: stderr.slice(0, 200),
        }));
        return;
      }

      // 6. Parse output
      let result;
      try {
        result = JSON.parse(raw);
      } catch {
        log.error('python output not JSON', { symbol: sym, raw: raw.slice(0, 200) });
        reject(new InferenceError('PARSE_ERROR', 'Python stdout is not valid JSON', {
          raw: raw.slice(0, 100),
        }));
        return;
      }

      // 7. Validate output schema
      try {
        validatePythonOutput(result);
      } catch (err) {
        if (err instanceof SchemaError) {
          log.error('python output schema error', { symbol: sym, errors: err.errors });
          reject(new InferenceError('SCHEMA_ERROR', err.message, { errors: err.errors }));
        } else {
          reject(err);
        }
        return;
      }

      log.info('inference success', {
        symbol: sym,
        modelId: champion.modelId,
        prediction: result.prediction,
        confidence: result.confidence,
        latencyMs,
      });

      resolve({
        prediction:    result.prediction,
        confidence:    result.confidence,
        probabilities: result.probabilities,
        modelId:       champion.modelId,
        modelType:     champion.modelType,
        symbol:        sym,
        featureNames:  champion.featureSet,
        championSince: champion.championSince,
        latencyMs,
        inferredAt:    new Date().toISOString(),
      });
    });

    // Write payload to stdin; guard against broken-pipe race
    try {
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      reject(new InferenceError('STDIN_ERROR', 'Failed to write payload to Python stdin', {}));
    }
  });
}
