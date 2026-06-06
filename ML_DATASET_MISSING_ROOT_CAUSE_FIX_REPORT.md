# ML dataset_missing After Historical Dataset Selection — Root Cause Fix Report

## Summary

When a user selected a historical dataset and clicked Train in the ML panel, the backend
returned `dataset_missing` instead of training. Five stacked root causes were found and fixed.

---

## Root Causes and Fixes

### RC-1: `api.trainMLModelP1` silently dropped `datasetId` from the POST body

**File:** `src/api.js`

The function destructured only `{ symbol, timeframe, horizon, datasetPath, promote }` — `datasetId`
was never included in the JSON body sent to the server.

**Fix:** Added `datasetId` to the destructuring and `body: JSON.stringify({..., datasetId: datasetId || undefined})`.

---

### RC-2: No mechanism to select a dataset for ML training

**Files:** `src/store/historicalDataStore.js`, `src/workspaces/HistoricalDataWorkspace.jsx`,
`src/components/TrainingRunsPanel.jsx`, `src/store/mlStore.js`

There was no `selectedMlDatasetId` state, no "Use for ML Training" button, and no place for
the user to designate which downloaded dataset should be used.

**Fix:**
- Added `selectedMlDatasetId`, `selectedMlDataset`, `mlDiagnostics`, `mlDiagnosticsLoading`,
  `mlDiagnosticsError` state to `historicalDataStore`.
- Added `selectForMlTraining(dataset)` action that sets the selection and loads diagnostics.
- Added `clearMlSelection()` action.
- `HistoricalDataWorkspace` DatasetTable now has a "Use ML" button per row with green highlight
  for the active selection, plus an ML status banner showing file readiness and a "Train Now" button.
- `TrainingRunsPanel` reads `selectedMlDatasetId` from `historicalDataStore` and passes it to
  `startTrain()`. Disabled when no dataset is selected.
- `mlStore.startTraining()` auto-injects `datasetId` (and `symbol`/`timeframe`) from
  `historicalDataStore.getState()` when the caller doesn't provide it.

---

### RC-3: Historical datasets saved as `.json` only — Python can't read JSON

**File:** `server/historical/historicalDataService.js`

`downloadHistoricalDataset` wrote only a `.json` archive file. `train_pipeline.py` requires
CSV or Parquet with specific columns: `timestamp, symbol, open, high, low, close, volume`.

**Fix:**
- Added `candlesToCsv(candles)` that formats timestamps as ISO 8601 strings and writes the
  required columns.
- `downloadHistoricalDataset` now writes **both** a `.json` archive (unchanged) and a `.csv`
  training file (`<basename>.csv`) in the same directory.
- `historicalDatasetRegistry.register()` now accepts `csvPath` and `csvSize`.
- `listDatasets()` returns live `fileExists`, `csvFileExists`, and `status` fields per dataset.
- `deleteDataset()` removes both files.

---

### RC-4: No path resolution from `datasetId` to a training-ready file path

**Files:** `server/historical/historicalDataService.js`, `server/api/mlRoutes.js`

When `datasetId` arrived at `POST /api/ml/train`, there was no code to look it up in the
dataset registry and extract the CSV file path. The request passed straight to
`trainingService.train()` which only knew about `datasetPath`.

**Fix:**
- Added `resolveDatasetForTraining(datasetId)` — looks up the registry, prefers CSV over JSON
  (JSON is skipped because Python can't read it), and returns specific error codes:
  - `dataset_not_found` — id not in registry
  - `dataset_csv_missing` — JSON exists but no CSV (re-download needed)
  - `dataset_file_missing` — neither file on disk
- `mlRoutes.js` calls `resolveDatasetForTraining` before `trainingService.train()` and maps
  each error code to the correct HTTP status and response.
- Added `diagnoseDataset(datasetId)` for the diagnostics endpoint.

---

### RC-5: `trainingService.train()` returned generic `dataset_missing` even when `datasetId` was provided

**File:** `server/ai/trainingService.js`

When `locateDataset()` returned null, the service always returned `dataset_missing` regardless
of whether a `datasetId` was in the request body. This masked the actual problem.

**Fix:** After `locateDataset()` returns null, check if `body.datasetId` was provided:
- If yes → return `dataset_not_found` with the specific `datasetId` (safety-net).
- If no  → return `dataset_missing` with `expectedPaths` (original behavior).

Also added an explicit `dataset_file_empty` check.

---

## Diagnostics Endpoint

`GET /api/historical/datasets/:id/diagnostics` returns:

```json
{
  "registryFound": true,
  "fileExists": true,
  "csvFileExists": true,
  "usableForMl": true,
  "issues": []
}
```

This is called automatically when a dataset is selected for ML training in the frontend,
and the result is displayed in the ML Training Dataset banner.

---

## Error Priority Chain

When `datasetId` is provided in the train request:

1. `dataset_not_found` (404) — id not in backend registry
2. `dataset_file_missing` (404) — no file on disk
3. `dataset_csv_missing` (422) — JSON exists but CSV not generated → re-download
4. `dataset_file_empty` (200, ok:false) — file exists but is 0 bytes
5. `not_enough_data` (200, ok:false) — too few rows for ML
6. `training_failed` (200, ok:false) — Python process error

`dataset_missing` is **only** returned when no `datasetId` or `datasetPath` was provided at all.

---

## Tests

- `server/tests/historicalRoutes.test.js` — 11 new tests covering providers, datasets list
  (with live file fields), diagnostics endpoint, status, download validation, delete.
- `server/tests/mlRoutes.test.js` — 3 new tests:
  - `datasetId` unknown → `dataset_not_found` (not `dataset_missing`)
  - `datasetId` registered with JSON but no CSV → `dataset_csv_missing`
  - existing test: no datasetId at all → `dataset_missing` (unchanged behavior)
