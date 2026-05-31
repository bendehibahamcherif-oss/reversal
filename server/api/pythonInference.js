/**
 * pythonInference.js
 *
 * Persistent Python subprocess manager for the ML Signal Engine.
 *
 * Design
 * ------
 *  - Spawns `python3 server/ai/inference/infer_worker.py` exactly once on first
 *    use (lazy init).  Subsequent calls reuse the same long-lived process.
 *  - Reads the startup line {"ready": true, ...} before accepting requests.
 *  - Communicates via newline-delimited JSON (JSON Lines) over stdin / stdout.
 *  - Each request is assigned a crypto.randomUUID() requestId and a Promise
 *    stored in _pending.  The readline loop resolves / rejects by requestId.
 *  - Hard timeout: ML_INFER_TIMEOUT_MS (default 400 ms).
 *  - Auto-restart: up to MAX_RESTARTS (3) times on crash.
 *  - Stderr from the worker is forwarded to process.stderr with a
 *    "[infer-worker]" prefix.
 *
 * Protocol (as defined by infer_worker.py)
 * ----------------------------------------
 *  Startup (first stdout line):
 *    {"ready": true, "model_version": str, "loaded_at": str}
 *    {"ready": false, "error": str, "code": str}   ← fatal
 *
 *  Request  (Node → worker stdin, one JSON line):
 *    {
 *      "request_id":    str,
 *      "features":      {name: float, ...},
 *      "feature_names": [str, ...],
 *      "inv_label_map": {"0": "SHORT", "1": "NEUTRAL", "2": "LONG"}
 *    }
 *
 *  Response (worker stdout → Node, one JSON line):
 *    {
 *      "request_id":    str,
 *      "ok":            true,
 *      "signal":        str,
 *      "probability":   float,
 *      "confidence":    float,
 *      "probabilities": {label: float, ...},
 *      "latency_ms":    float
 *    }
 *    | {"request_id": str, "ok": false, "error": str, "code": str}
 */

import { spawn }         from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath }  from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID }     from 'node:crypto';

// ── Custom error classes ──────────────────────────────────────────────────────

export class InferenceTimeoutError extends Error {
  /**
   * @param {string} requestId
   * @param {number} timeoutMs
   */
  constructor(requestId, timeoutMs) {
    super(`Inference request ${requestId} timed out after ${timeoutMs}ms`);
    this.name      = 'InferenceTimeoutError';
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

export class InferenceWorkerError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code) {
    super(message);
    this.name = 'InferenceWorkerError';
    this.code = code ?? 'WORKER_ERROR';
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIMEOUT_MS             = Number(process.env.ML_INFER_TIMEOUT_MS) || 400;
const MAX_RESTARTS           = 3;
const WORKER_READY_TIMEOUT_MS = 15_000;

const __filename   = fileURLToPath(import.meta.url);
const __dirname    = dirname(__filename);
// server/api/ → up two levels → project root → server/ai/inference/infer_worker.py
const WORKER_SCRIPT = resolve(__dirname, '..', 'ai', 'inference', 'infer_worker.py');
const MODELS_DIR    = resolve(__dirname, '..', 'ai', 'models');

// ── Module-level state ────────────────────────────────────────────────────────

/** @type {import('node:child_process').ChildProcess | null} */
let _worker = null;

/**
 * Resolves when the current worker has emitted {"ready": true}.
 * Set to null whenever the worker is not running.
 * @type {Promise<void> | null}
 */
let _readyPromise = null;

/**
 * Pending inference requests keyed by requestId.
 * @type {Map<string, {
 *   resolve: (msg: object) => void,
 *   reject:  (err: Error)  => void,
 *   timer:   ReturnType<typeof setTimeout>,
 *   cancelled: boolean
 * }>}
 */
const _pending = new Map();

let _restarts      = 0;
let _totalRequests = 0;
let _totalErrors   = 0;
let _workerPid     = null;
let _workerAlive   = false;
let _modelVersion  = null;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Write a prefixed line to process.stderr (never throws). */
function _log(msg) {
  try {
    process.stderr.write(`[infer-worker] ${msg}\n`);
  } catch (_) { /* ignore */ }
}

/**
 * Drain all pending promises with an error.  Used when the worker dies
 * unexpectedly.
 * @param {Error} err
 */
function _rejectAllPending(err) {
  for (const [reqId, entry] of _pending) {
    clearTimeout(entry.timer);
    _pending.delete(reqId);
    if (!entry.cancelled) {
      _totalErrors++;
      entry.reject(err);
    }
  }
}

/**
 * Spawn the Python worker and return a Promise that resolves once the worker
 * emits {"ready": true, ...}.  Stores the process in _worker.
 *
 * Sets _readyPromise before returning so concurrent callers can await the same
 * promise instead of spawning twice.
 *
 * @returns {Promise<void>}
 */
function _spawnWorker() {
  // Already spawning — reuse the in-flight promise.
  if (_readyPromise) return _readyPromise;

  _readyPromise = new Promise((resolveReady, rejectReady) => {
    const workerEnv = {
      ...process.env,
      ML_MODELS_DIR: process.env.ML_MODELS_DIR ?? MODELS_DIR,
    };

    const proc = spawn('python3', [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   workerEnv,
    });

    _worker      = proc;
    _workerAlive = false;
    _workerPid   = null;

    // ── Stderr: forward to process.stderr with prefix ───────────────────────
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim()) _log(line);
      }
    });

    // ── Stdout: line-buffered JSON ───────────────────────────────────────────
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    let startupDone = false;

    /** Called once — either by the ready message or by the startup timer. */
    function _failStartup(err) {
      if (startupDone) return;
      startupDone  = true;
      _workerAlive = false;
      _readyPromise = null;
      clearTimeout(startupTimer);
      try { proc.kill('SIGTERM'); } catch (_) { /* already dead */ }
      rejectReady(err);
    }

    const startupTimer = setTimeout(() => {
      _failStartup(
        new InferenceWorkerError(
          `Worker did not become ready within ${WORKER_READY_TIMEOUT_MS}ms`,
          'STARTUP_TIMEOUT',
        ),
      );
    }, WORKER_READY_TIMEOUT_MS);

    rl.on('line', (raw) => {
      const line = raw.trim();
      if (!line) return;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (parseErr) {
        _log(`Unparseable stdout line: ${line}`);
        return;
      }

      // ── Startup handshake ─────────────────────────────────────────────────
      if (!startupDone) {
        // Worker sends {"ready": true|false, ...} as the very first line.
        if (msg.ready === true) {
          startupDone   = true;
          clearTimeout(startupTimer);
          _workerAlive  = true;
          _workerPid    = proc.pid;
          _modelVersion = msg.model_version ?? null;
          resolveReady();
          return;
        }

        if (msg.ready === false) {
          _failStartup(
            new InferenceWorkerError(
              `Worker startup failed: ${msg.error ?? 'unknown error'} (code=${msg.code ?? 'UNKNOWN'})`,
              msg.code ?? 'STARTUP_FAILED',
            ),
          );
          return;
        }

        // Any other first line is unexpected; treat as a non-fatal log event
        // (perhaps the worker emitted a warning before the ready line).
        _log(`Pre-ready stdout: ${line}`);
        return;
      }

      // ── Dispatch to pending promise ───────────────────────────────────────
      const requestId = msg.request_id;
      if (!requestId) {
        _log(`Response missing request_id: ${line}`);
        return;
      }

      const entry = _pending.get(requestId);
      if (!entry) {
        // Already timed out or cancelled — silently discard.
        return;
      }

      clearTimeout(entry.timer);
      _pending.delete(requestId);

      if (entry.cancelled) return;

      if (msg.ok === false) {
        _totalErrors++;
        entry.reject(
          new InferenceWorkerError(
            msg.error ?? 'Worker returned ok:false',
            msg.code  ?? 'WORKER_ERROR',
          ),
        );
      } else {
        entry.resolve(msg);
      }
    });

    // ── Process exit ─────────────────────────────────────────────────────────
    proc.on('exit', (code, signal) => {
      _workerAlive  = false;
      _readyPromise = null;
      _worker       = null;

      if (!startupDone) {
        _failStartup(
          new InferenceWorkerError(
            `Worker process exited before ready (code=${code}, signal=${signal})`,
            'STARTUP_EXIT',
          ),
        );
        return;
      }

      // Reject all in-flight requests.
      _rejectAllPending(
        new InferenceWorkerError(
          `Worker process exited unexpectedly (code=${code}, signal=${signal})`,
          'WORKER_CRASHED',
        ),
      );

      _log(`Worker exited (code=${code}, signal=${signal}).  Total restarts so far: ${_restarts}`);
    });

    // ── Spawn error (e.g. python3 not on PATH) ────────────────────────────────
    proc.on('error', (err) => {
      _workerAlive  = false;
      _readyPromise = null;
      _worker       = null;

      const wrapped = new InferenceWorkerError(
        `Failed to spawn worker: ${err.message}`,
        'SPAWN_ERROR',
      );

      if (!startupDone) {
        _failStartup(wrapped);
      } else {
        _rejectAllPending(wrapped);
      }
    });
  });

  return _readyPromise;
}

/**
 * Ensure a healthy worker is running.  Spawns (or restarts) as needed,
 * respecting MAX_RESTARTS.
 *
 * @returns {Promise<void>}
 */
async function _ensureWorker() {
  // Worker is alive and startup already resolved — nothing to do.
  if (_workerAlive) return;

  // A spawn is already in flight — wait for it.
  if (_readyPromise) {
    await _readyPromise;
    return;
  }

  // Need a fresh spawn.  Count restarts if this is not the first spawn.
  if (_worker !== null) {
    _restarts++;
    if (_restarts > MAX_RESTARTS) {
      throw new InferenceWorkerError(
        `Worker has crashed ${_restarts - 1} time(s); max restarts (${MAX_RESTARTS}) exceeded.`,
        'MAX_RESTARTS_EXCEEDED',
      );
    }
    _log(`Restarting worker (attempt ${_restarts}/${MAX_RESTARTS})…`);
  }

  await _spawnWorker();
}

// ── Public API ────────────────────────────────────────────────────────────────

export const pythonInference = {
  /**
   * Run a single inference request through the persistent Python worker.
   *
   * @param {{
   *   features:     Record<string, number>,
   *   featureNames: string[],
   *   invLabelMap:  Record<string, string>
   * }} params
   * @returns {Promise<{
   *   signal:        string,
   *   probability:   number,
   *   confidence:    number,
   *   probabilities: Record<string, number>,
   *   latencyMs:     number
   * }>}
   * @throws {InferenceTimeoutError}
   * @throws {InferenceWorkerError}
   */
  async infer({ features, featureNames, invLabelMap }) {
    await _ensureWorker();

    const requestId = randomUUID();
    _totalRequests++;

    // Build the JSON-Lines payload using the wire format expected by the Python
    // worker (snake_case keys: request_id, feature_names, inv_label_map).
    const payload = {
      request_id:   requestId,
      features,
      feature_names: featureNames,
      inv_label_map: invLabelMap,
    };

    return new Promise((resolve, reject) => {
      // ── Hard timeout ──────────────────────────────────────────────────────
      const timer = setTimeout(() => {
        const entry = _pending.get(requestId);
        if (entry) {
          entry.cancelled = true;
          _pending.delete(requestId);
        }
        _totalErrors++;
        reject(new InferenceTimeoutError(requestId, TIMEOUT_MS));
      }, TIMEOUT_MS);

      _pending.set(requestId, {
        resolve: (msg) => {
          resolve({
            signal:        msg.signal,
            probability:   msg.probability,
            confidence:    msg.confidence,
            probabilities: msg.probabilities ?? {},
            latencyMs:     msg.latency_ms    ?? 0,
          });
        },
        reject,
        timer,
        cancelled: false,
      });

      // ── Write request to worker stdin ─────────────────────────────────────
      try {
        _worker.stdin.write(JSON.stringify(payload) + '\n');
      } catch (writeErr) {
        clearTimeout(timer);
        _pending.delete(requestId);
        _totalErrors++;
        reject(
          new InferenceWorkerError(
            `Failed to write to worker stdin: ${writeErr.message}`,
            'STDIN_ERROR',
          ),
        );
      }
    });
  },

  /**
   * Return health / diagnostic information about the worker subprocess.
   *
   * @returns {Promise<{
   *   ok:            boolean,
   *   workerAlive:   boolean,
   *   pid:           number | null,
   *   restarts:      number,
   *   totalRequests: number,
   *   errors:        number,
   *   modelVersion:  string | null,
   *   pendingCount:  number
   * }>}
   */
  async health() {
    return {
      ok:            _workerAlive,
      workerAlive:   _workerAlive,
      pid:           _workerPid,
      restarts:      _restarts,
      totalRequests: _totalRequests,
      errors:        _totalErrors,
      modelVersion:  _modelVersion,
      pendingCount:  _pending.size,
    };
  },

  /**
   * Gracefully shut down the Python worker.
   * Closes stdin (causes the worker's for-loop to exit cleanly), then sends
   * SIGTERM as a safety net.  All in-flight requests are rejected immediately.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    _readyPromise = null;
    _workerAlive  = false;
    _workerPid    = null;
    _modelVersion = null;

    // Reject all pending requests first so callers aren't left hanging.
    _rejectAllPending(new InferenceWorkerError('Worker was shut down', 'SHUTDOWN'));

    if (_worker) {
      try { _worker.stdin.end(); }   catch (_) { /* ignore */ }
      try { _worker.kill('SIGTERM'); } catch (_) { /* ignore */ }
      _worker = null;
    }
  },
};
