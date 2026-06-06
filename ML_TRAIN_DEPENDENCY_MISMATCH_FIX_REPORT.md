# ML Train Dependency Mismatch Fix Report

## 1. `/api/ml/dependencies` output

Production output reported in the mission:

```json
{
  "ok": true,
  "status": "ready",
  "python": {
    "available": true,
    "version": "3.14.3"
  },
  "dependencies": {
    "numpy": true,
    "pandas": true,
    "sklearn": true,
    "joblib": true,
    "pyarrow": true,
    "xgboost": true
  },
  "missing": [],
  "pythonBin": "python3"
}
```

Local validation in this container is not dependency-ready; `node scripts/check-ml-deps.js` wrote `ML_DEPENDENCY_CHECK_RESULTS.json` with `status: "python_dependency_missing"` for `numpy`, `pandas`, `sklearn`, and `joblib` under `python3` / Python `3.12.13`.

## 2. `/api/ml/train` output before fix

Before this fix, `GET /api/ml/dependencies` and `POST /api/ml/train` had separate dependency probes. Production facts showed `/api/ml/dependencies` returning `ready`, while AI Lab / Train Model still showed:

```json
{
  "ok": false,
  "status": "python_dependency_missing",
  "message": "Python ML dependencies are missing. Install requirements-ml.txt before training."
}
```

That response did not include the train-route Python diagnostic fields needed to prove which Python binary, version, dependency status, and missing modules were used by the train preflight.

## 3. Root cause of mismatch

The mismatch was caused by duplicated dependency logic:

- `GET /api/ml/dependencies` had an inline route-local Python probe.
- `POST /api/ml/train` used a separate `checkPythonDeps()` helper in `trainingService.js`.
- The two code paths could diverge in module lists, parse behavior, Python binary resolution, and response diagnostics.

The fix creates a single exported runtime readiness probe, `probePythonDependencies()`, in `server/ai/trainingService.js`. Both `/api/ml/dependencies` and train preflight now call that same function with the same `getPythonBin()` result. Required dependencies are the core runtime training modules: `numpy`, `pandas`, `sklearn`, and `joblib`; `pyarrow` and `xgboost` are reported in the dependency map but do not block readiness unless training code makes them mandatory later.

## 4. Whether frontend stale status was involved

No frontend layout changes were made. A small state helper was added to model the required behavior:

- stale `python_dependency_missing` is cleared when dependency status becomes `ready`;
- clicking Train Model transitions state to `training` before the request;
- the latest train response replaces the old error.

Tests cover those state transitions. This protects the UI path from preserving a stale old dependency error after the backend is ready.

## 5. Train route after fix

After the fix:

1. The train request body is validated.
2. `datasetId` is resolved before training.
3. Dataset existence is verified.
4. Dataset file existence/non-empty state is verified.
5. The shared dependency probe runs.
6. If the probe is ready, `train_pipeline.py` is called.
7. The pipeline result is returned.

If the shared dependency probe returns `ready`, `trainingService.train()` does not return `python_dependency_missing`. If the Python pipeline itself unexpectedly emits `python_dependency_missing` after a ready preflight, the service converts that mismatch into `training_failed` with pipeline details instead of reporting a stale dependency-missing state.

Training failures after dependency preflight now include diagnostics like:

```json
{
  "ok": false,
  "status": "...",
  "message": "...",
  "datasetId": "...",
  "python": {
    "bin": "python3",
    "version": "...",
    "dependencyStatus": "ready",
    "missing": []
  }
}
```

When status is `python_dependency_missing`, the top-level `missing` array and `python.missing` array are populated from the shared readiness probe.

## 6. Tests added

Added and updated tests for:

1. Ready dependency checker does not let `TrainingService` return `python_dependency_missing`.
2. Missing `pandas` dependency returns `python_dependency_missing` with `missing: ["pandas"]`.
3. Train route failure responses include Python dependency diagnostics.
4. Frontend state clears stale `python_dependency_missing` when dependencies are ready.
5. Frontend state sets `training` for a fresh request and replaces the old error with the latest train response.

## 7. Validation result

Commands run:

- `npm test` — passed.
- `npm run build` — passed.
- `node scripts/check-ml-deps.js` — failed in this container because Python ML packages are not installed locally; the script correctly wrote `ML_DEPENDENCY_CHECK_RESULTS.json`.
- `node scripts/ml-train-smoke.js` — failed at the required dependency-ready assertion in this container because `/api/ml/dependencies` returned `python_dependency_missing`; the script correctly wrote `ML_TRAIN_SMOKE_RESULTS.json` and would fail with `BUG: train route dependency check disagrees with /api/ml/dependencies` if train disagrees after dependencies are ready.

## Deployment verification checklist

After deploying this commit, verify production with the selected dataset:

```bash
curl -s https://reversal.onrender.com/api/ml/dependencies
curl -s -X POST https://reversal.onrender.com/api/ml/train \
  -H 'content-type: application/json' \
  -d '{"symbol":"SPY","timeframe":"1d","horizon":10,"datasetId":"hist_SPY_1d_RTH_20250606_20260606_yahoo","promote":false}'
```

Expected production behavior: if `/api/ml/dependencies` returns `status: "ready"`, `/api/ml/train` must not return `status: "python_dependency_missing"`. It may return `trained`, `not_enough_data`, `dataset_file_missing`, `dataset_file_empty`, or `training_failed` with real Python stderr/details.
