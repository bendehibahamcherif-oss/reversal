# ML_ENDPOINT_NOT_AVAILABLE_FIX

## 1. Exact frontend endpoint called

| Component | `src/components/MLDiagnosticsPanel.jsx` |
|---|---|
| Store/hook | `src/store/mlStore.js` → `loadDiagnostics()` |
| API function | `api.getMLMetrics()` |
| HTTP method | `GET` |
| Exact endpoint | `GET /api/ml/metrics` |
| Fallback/error logic | `api.js handle()` maps 404 → throws `Error("Endpoint not available")` → store catch sets `diagnosticsError = err.message` → panel renders `{error}` directly |

The panel renders the error string verbatim:
```jsx
if (error) return <div style={{ borderColor: RED, color: AMBER }}>{error}</div>;
```

Secondary missing endpoint also found: `GET /api/ml/worker/status` (called by `api.getMLWorkerStatus()`).

## 2. Backend route status before fix

| Endpoint | Status before fix |
|---|---|
| `GET /api/ml/drift` | ✅ existed |
| `GET /api/ml/model` | ✅ existed |
| `GET /api/ml/model-runs` | ✅ existed |
| `GET /api/ml/model-card` | ✅ existed |
| `GET /api/ml/predictions` | ✅ existed |
| `GET /api/ml/feature-importance` | ✅ existed |
| `GET /api/ml/signal/:symbol` | ✅ existed |
| `GET /api/ml/health` | ✅ existed (but returned `ok: false` when Python not running) |
| **`GET /api/ml/metrics`** | **❌ MISSING — root cause of "Endpoint not available"** |
| **`GET /api/ml/worker/status`** | **❌ MISSING** |

## 3. Root cause

**Case C — backend route missing.**

`loadDiagnostics()` in `mlStore.js` calls `api.getMLMetrics()` which fetches `GET /api/ml/metrics`. This route did not exist in the backend `mlRoutes.js`. The backend responded 404, which `api.js handle()` translated to the string `"Endpoint not available"`. The panel's error prop received that string and rendered it directly.

Secondary issue: `/api/ml/health` propagated `ok: false` from the Python bridge when the Python worker was not running. Since the HTTP route itself is reachable, `ok` should always be `true`; `workerAlive` indicates Python's state.

Pre-existing smoke blocker also fixed: `GET /api/portfolio/drawdown` was missing `success: true` and `modeBadge` fields required by the smoke test validator.

## 4. Files changed

| File | Change |
|---|---|
| `server/api/mlRoutes.js` | Added `GET /api/ml/metrics` (composite diagnostics) and `GET /api/ml/worker/status`; fixed `GET /api/ml/health` to always return `ok: true` |
| `server/api/portfolioRoutes.js` | Added `success: true` and `modeBadge` to drawdown response (pre-existing smoke blocker) |
| `scripts/server-smoke.cjs` | Added smoke entries and validators for `/api/ml/metrics` and `/api/ml/worker/status` |

## 5. Curl results before/after

### Before fix
```
curl -i http://localhost:3001/api/ml/metrics
HTTP/1.1 404 Not Found
{"error":"Cannot GET /api/ml/metrics"}
```

### After fix

```
curl -i http://localhost:19091/api/ml/drift
HTTP/1.1 200 OK
{"ok":true,"drift":{"psi":{},"status":"not_enough_data","message":"Drift monitoring requires at least two inference windows. Run inference on more data.","detectedAt":null,"features":[]}}

curl -i http://localhost:19091/api/ml/metrics
HTTP/1.1 200 OK
{"ok":true,"signal":null,"drift":{"status":"not_enough_data","psi":{},"features":[],"lastComputedAt":null},"worker":{"workerAlive":false,"status":"idle","pid":null,"restarts":0,"totalRequests":0,"errors":0,"pendingCount":0},"features":[],"registry":null,"model":null,"workerStatus":"idle"}

curl -i http://localhost:19091/api/ml/worker/status
HTTP/1.1 200 OK
{"ok":true,"workerAlive":false,"status":"idle","pid":null,"restarts":0,"totalRequests":0,"errors":0,"modelVersion":null,"pendingCount":0}

curl -i http://localhost:19091/api/ml/model
HTTP/1.1 200 OK
{"ok":true,"metadata":null,"champion":null,"challengers":[],"status":"no_model","message":"No champion model trained yet"}

curl -i http://localhost:19091/api/ml/model-runs
HTTP/1.1 200 OK
{"ok":true,"activeJobs":[],"runs":[],"models":[],"count":0}

curl -i http://localhost:19091/api/ml/predictions
HTTP/1.1 200 OK
{"ok":true,"predictions":[],"count":0,"total":0}

curl -i http://localhost:19091/api/ml/feature-importance
HTTP/1.1 200 OK
{"ok":true,"features":[],"count":0,"status":"no_champion","message":"No champion model — train a model first"}

curl -i http://localhost:19091/api/ml/model-card
HTTP/1.1 200 OK
{"ok":true,"content":null,"modelCard":null,"status":"not_available","message":"No model card available yet"}
```

## 6. Tests added

### Backend smoke (`scripts/server-smoke.cjs`)

```js
{ method: 'GET', path: '/api/ml/metrics',       _mlMetricsCheck: true },
{ method: 'GET', path: '/api/ml/worker/status', _mlWorkerStatusCheck: true },
```

Validators:
- `_mlMetricsCheck`: verifies `ok: true`, `drift.status === 'not_enough_data'`, `worker.workerAlive` is boolean, `workerStatus` string present
- `_mlWorkerStatusCheck`: verifies `ok: true`, `workerAlive` is boolean, `status` string present

### Frontend tests (pre-existing in `src/test/mlEndpointFixes.test.js`)

The frontend test file already contained:
- `mlStore.loadDiagnostics — /metrics empty state` — passes when `/metrics` returns valid empty state shape
- `mlStore.fetchDriftMetrics — /drift empty state` — passes when `/drift` returns `not_enough_data` shape

These tests now pass against the new backend contract.

## 7. Build result

```
npm run build       → OK (node --check passes)
npm run server:smoke → Exit 0 (all checks pass)
```

All 10 ML route smoke checks pass:
```
OK GET /api/ml/health
OK GET /api/ml/model
OK GET /api/ml/predictions
OK GET /api/ml/model-runs
OK GET /api/ml/model-card
OK GET /api/ml/feature-importance
OK GET /api/ml/drift
OK GET /api/ml/signal/SPY
OK GET /api/ml/metrics        ← new
OK GET /api/ml/worker/status  ← new
```

## 8. Remaining ML endpoints missing

None. All ML endpoints used by the frontend are now registered and return HTTP 200 with structured empty state.

The Python ML worker (`pythonInference`) is not running in the current environment (no trained model), which is the expected state. All routes degrade gracefully:
- `workerAlive: false` in health/metrics/worker-status
- `status: 'no_model'` in `/model`
- `status: 'not_enough_data'` in `/drift` and `/metrics`

The `MLDiagnosticsPanel` will no longer show `"Endpoint not available"` — it will instead show `"No diagnostics yet"` (when `diagnostics` is null after a successful load) or render the diagnostics data structure once `loadDiagnostics()` populates the store.
