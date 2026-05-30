// ── ML Worker Pool ─────────────────────────────────────────────────────────
//
// Pool seam — currently routes every call to a single-process worker.
// The public interface (pool.infer / pool.getStats) is stable so callers
// don't change when the implementation is swapped for a real pool.
//
// Migration path to true worker pool:
//   1.  npm install piscina          (thread pool) or implement multiprocess queue
//   2.  Replace _runSingle() with:   piscina.run({ symbol, features, modelId })
//   3.  ML_WORKER_POOL_SIZE controls max concurrency (already read from env)
//   4.  Move _inFlight / latency tracking into pool.stats callback
//
// Why the seam matters:
//   Python startup (xgboost + sklearn import) costs ~200-500 ms per cold spawn.
//   A pool pre-warms workers so only the inference step (~5-20 ms) is on the
//   hot path, keeping total latency well under the 400 ms hard limit.

import { runInferenceWorker, HARD_TIMEOUT_MS } from './inferenceWorker.js';
import { logger as _log } from '../observability/logger.js';

const log = _log.child({ component: 'mlWorkerPool' });

const MAX_CONCURRENCY = Number(process.env.ML_WORKER_POOL_SIZE || 4);

class MlWorkerPool {
  constructor() {
    this._inFlight      = 0;
    this._totalRequests = 0;
    this._totalErrors   = 0;
    this._totalTimeouts = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async infer(symbol, features, { modelId } = {}) {
    this._totalRequests++;
    this._inFlight++;

    log.debug('pool.infer enter', {
      symbol, inFlight: this._inFlight, maxConcurrency: MAX_CONCURRENCY,
    });

    try {
      return await runInferenceWorker({ symbol, features, modelId });
    } catch (err) {
      this._totalErrors++;
      if (err.code === 'TIMEOUT') this._totalTimeouts++;
      throw err;
    } finally {
      this._inFlight--;
    }
  }

  getStats() {
    return {
      poolType:       'single-process',
      inFlight:       this._inFlight,
      maxConcurrency: MAX_CONCURRENCY,
      totalRequests:  this._totalRequests,
      totalErrors:    this._totalErrors,
      totalTimeouts:  this._totalTimeouts,
      hardTimeoutMs:  HARD_TIMEOUT_MS,
      pythonBin:      process.env.PYTHON_BIN || 'python3',
      upgradeNote:    'Set ML_WORKER_POOL_SIZE and swap _runSingle for piscina pool to eliminate cold-start latency',
    };
  }
}

export const mlWorkerPool = new MlWorkerPool();
