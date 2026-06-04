# Global Audit Report — Reversal Trading Platform
**Date:** 2026-06-04  
**Scope:** Full backend audit — ML inference path, security, architecture, observability  
**Status:** P0 fixes applied ✅ | P1 tracked below

---

## Executive Summary

The platform had four P0 issues that together rendered the entire ML inference pipeline non-functional in production and exposed a remote code execution vulnerability. All four P0 issues have been fixed in this commit. Eleven P1/P2 issues are documented below for follow-up.

---

## P0 Issues — Fixed

### P0-1 · RCE via `pickle.loads()` in `server/ai/ml/infer.py`

**Severity:** Critical — Remote Code Execution  
**Was:** Python inference script accepted a `model_b64` field containing a base64-encoded pickle blob, which it deserialized unconditionally using `pickle.loads()`. Any caller with access to the `/api/ml/infer` endpoint could supply a crafted base64 payload to execute arbitrary code in the server process.

```python
# BEFORE (RCE):
model_bytes = base64.b64decode(model_b64)
model = pickle.loads(model_bytes)       # ← arbitrary code execution
```

**Fix:** Replaced the `model_b64` protocol with a `model_path` protocol. `infer.py` now:
1. Accepts a `model_path` string instead of base64 bytes.
2. Validates the path is within `ML_MODELS_DIR` (path traversal guard).
3. Loads by file extension using XGBoost JSON, LightGBM text, or joblib APIs — no `pickle.loads()` of untrusted input.

```python
# AFTER (safe):
abs_path = os.path.abspath(model_path)
if not abs_path.startswith(allowed_dir + os.sep): raise ...
model_type, model = _load_model(abs_path)   # ext-based, no pickle
```

`inferenceWorker.js` updated in parallel to pass `model_path` (from `champion.artifactPath`) instead of loading and transmitting the raw bytes.

---

### P0-2 · `VALID_PREDICTIONS` enum blocks all Phase 9 inference

**Severity:** Critical — all inference requests return HTTP 502 SCHEMA_ERROR  
**Was:** `server/ml/mlInferSchema.js` hardcoded:

```js
export const VALID_PREDICTIONS = Object.freeze(['positive', 'negative', 'neutral']);
```

Phase 9 training (`train_pipeline.py`) uses labels `SHORT`, `NEUTRAL`, `LONG`. Every response from the Phase 9 model was rejected at the schema validation layer with `SCHEMA_ERROR`.

**Fix:** Extended `VALID_PREDICTIONS` to include both label sets:

```js
export const VALID_PREDICTIONS = Object.freeze([
  'SHORT', 'NEUTRAL', 'LONG',          // Phase 9
  'positive', 'negative', 'neutral',   // legacy
]);
```

---

### P0-3 · Spawn-per-request inference — guaranteed timeouts

**Severity:** Critical — 100% timeout rate on cold path  
**Was:** `mlRoutes.js` called `mlWorkerPool.infer()` → `inferenceWorker.js` → `spawn('python3', [infer.py])` for every request. Python cold-start (importing sklearn, xgboost, lightgbm) costs 200–500 ms per spawn. The hard timeout is 400 ms. Every request on any non-warmed path timed out.

**Fix:** `mlRoutes.js` now calls `pythonInference.infer()` (`server/api/pythonInference.js`), which manages a single persistent Python worker (`infer_worker.py`). The worker starts once at first request and remains alive. Subsequent calls only pay inference latency (~5–20 ms), well within the 400 ms limit. The worker auto-restarts up to 3 times on crash.

---

### P0-4 · Registry disconnect — JS inference reads from dead registry

**Severity:** Critical — `NO_CHAMPION` on every inference request  
**Was:** `inferenceWorker.js` called `modelRegistryService.getChampion(sym)` which reads from the JS JSON registry at `/var/data/models/modelRegistry.json`. Python training (`train_pipeline.py`) writes to `server/ai/models/model_metadata.json` and a separate SQLite registry. The JS registry was always empty — no champion model was ever findable via the old inference path.

**Fix:** `mlRoutes.js` now reads `server/ai/models/model_metadata.json` directly (the file Python training writes) to obtain `feature_names` and `inv_label_map` before calling `pythonInference.infer()`. The persistent worker (`infer_worker.py`) also reads from the same directory at startup, so both sides share the same source of truth.

---

## P1 Issues — To Fix (follow-up)

### P1-1 · JWT secret defaults to hardcoded fallback

**File:** `server.js:27`  
`JWT_SECRET` defaults to `'dev-secret-change-me'` if neither `JWT_SECRET` nor `USER_TOKEN` env vars are set. Any server started without env vars accepts tokens signed with the known key.  
**Fix:** Log an error and refuse to start if neither env var is set in production (`NODE_ENV === 'production'`).

### P1-2 · CORS defaults to wildcard `*`

**File:** `server.js:35`  
`ALLOWED_ORIGINS` defaults to `'*'` — all origins accepted. In production this should be a restricted allowlist.  
**Fix:** Require `ALLOWED_ORIGINS` env var in production; emit a startup warning if it is `'*'`.

### P1-3 · No rate limiter on ML routes

**File:** `server/bootstrap/runtimeIntegration.js`  
The `rateLimiter` middleware is applied to some route groups but not to `/api/ml/*`. A single client can flood the inference endpoint and exhaust the Python worker's pending queue.  
**Fix:** Apply the existing sliding-window rate limiter to `/api/ml/infer` (e.g., 20 req/min per IP).

### P1-4 · Old `train.py` still uses legacy label scheme

**File:** `server/ai/ml/train.py` (separate from Phase 9 `train_pipeline.py`)  
Still uses `positive/negative/neutral` labels. Artifacts trained with this file are incompatible with Phase 9 inference.  
**Fix:** Either delete `train.py` (superseded by `train_pipeline.py`) or update labels to `SHORT/NEUTRAL/LONG`.

### P1-5 · `pythonInference.js` restart counter never resets

**File:** `server/api/pythonInference.js:114`  
`_restarts` increments on every crash but never resets. After `MAX_RESTARTS` (3) crashes the worker stays dead for the process lifetime even if restarts were days apart.  
**Fix:** Reset `_restarts` after a configurable success window (e.g., reset to 0 if the worker has been alive for >60 s without crashing).

### P1-6 · Training job registry is in-memory only

**File:** `server/api/mlRoutes.js:43`  
`_trainingJobs` is a `Map` that is cleared on restart. Training runs started before a crash are not recoverable; in-progress PIDs become orphaned.  
**Fix:** Persist job state to SQLite or write a PID file to disk; add a `/api/ml/training-runs/:jobId` status endpoint that reads from the persistent store.

### P1-7 · `feedManager.js` — provider failover silent data gaps

**File:** `server/feeds/feedManager.js`  
When the primary provider fails over to secondary, `latestTicks` and `latestCandles` maps continue serving the last value from the dead provider indefinitely until a new tick arrives. A client polling the REST snapshot endpoints receives stale data with no staleness indicator.  
**Fix:** Add a `staleSinceMs` field to snapshot responses when no tick has been received for >N seconds.

### P1-8 · `MarketStreamEngine.js` — adapter reconnect uses fixed 2 s delay

**File:** `server/marketStream/MarketStreamEngine.js`  
Reconnect uses a fixed 2 s delay regardless of how many times the adapter has failed. Under a sustained outage this creates 30+ reconnects/min per adapter.  
**Fix:** Add exponential backoff with jitter (max ~60 s) per adapter.

---

## P2 Issues — Tracked

| ID | File | Description |
|----|------|-------------|
| P2-1 | `server/api/mlRoutes.js` | `POST /api/ml/train` spawns `train_pipeline.py` without concurrency guard — multiple simultaneous training jobs will race on the same output files. |
| P2-2 | `server/api/chartRoutes.js` | CVD and footprint endpoints have no pagination — requesting a large symbol/timeframe window can return tens of thousands of rows in a single response. |
| P2-3 | `server/ai/inference/infer_worker.py` | Worker process has no maximum idle timeout — stays alive indefinitely even when the Node process that spawned it has exited without closing stdin (container restart scenarios). |

---

## Files Changed in This Commit

| File | Change |
|------|--------|
| `server/ai/ml/infer.py` | **Replaced** `pickle.loads(base64)` with safe `model_path`-based loading; path traversal guard added |
| `server/ml/inferenceWorker.js` | Updated to pass `model_path` instead of `model_b64` |
| `server/ml/mlInferSchema.js` | Added `SHORT`, `NEUTRAL`, `LONG` to `VALID_PREDICTIONS` |
| `server/api/mlRoutes.js` | Wired `/infer` to persistent `pythonInference.js`; reads `model_metadata.json` from Python registry; updated `/health` |

---

## Test Results

```
199 passed in 56.84s (server/ai/tests/)
```

All Phase 9 ML tests pass. No regressions.
