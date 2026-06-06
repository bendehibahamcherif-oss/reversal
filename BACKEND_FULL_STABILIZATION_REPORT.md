# Backend Full Stabilization Report

**Date:** 2026-06-06 · **Branch:** `claude/feed-chart-routes-format-f6bKw` · **Repo:** `reversal`

## 1. Executive Summary

This pass stabilized the backend API surface end-to-end and closed the remaining
gaps after PRs #95–#100. The bulk of the platform was already sound (routes
mounted, macro/beta NaN-safe, global JSON 404 + error middleware, ML deps endpoint,
sklearn `multi_class` fixed). This branch adds the genuinely missing pieces and
fixes one pre-existing failing test.

**New in this branch**
- **Dataset selection endpoints** (`POST /api/historical/use-for-ml | use-for-backtest | use-for-correlation`) — validate a dataset is usable for each target with a precise error chain; never return success with an undefined datasetId.
- **Centralized response helper** `server/utils/apiResponse.js` (`sendOk`, `sendError`, `sanitizeJson`) — NaN/Infinity→null, undefined dropped, Date→ISO, Error→safe object, BigInt→string, cycle-safe.
- **Enhanced `GET /api/ml/dependencies`** — `requiredMissing[]` / `optionalMissing[]` split, `ready_with_optional_missing` status, `python.bin`/`executable`; a missing *optional* dep (xgboost/lightgbm/pyarrow) no longer reports `python_dependency_missing`.
- **`requestId`** added to the global `internal_error` response.
- **`scripts/full-backend-smoke.js`** (`npm run smoke:backend`) — 16-endpoint release gate.
- **Fixed a pre-existing failing Python test** (`test_one_class_labels_return_not_enough_data`) introduced by PR #100.

**Result:** 76/76 Node tests · 218/218 Python tests · 16/16 backend smoke.

## 2. Bugs Found & Fixed

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | High | No `use-for-ml/backtest/correlation` endpoints — frontend dataset selection had no backend contract | Added 3 endpoints with shared `useDatasetForTarget()` helper + precise error chain |
| 2 | Medium | No shared JSON-safety/response helper; risk of NaN/Infinity/undefined/Date leaking | Added `server/utils/apiResponse.js` |
| 3 | Medium | `/api/ml/dependencies` lumped optional deps with required → a missing xgboost looked like a hard failure | Split required vs optional; new `ready_with_optional_missing` status |
| 4 | Low | `internal_error` responses had no correlation id | Added `requestId` |
| 5 | **Medium** | **Pre-existing**: `test_one_class_labels_return_not_enough_data` failed on `origin/main` (PR #100). Flat-price data made *all* feature rows NaN → 0 usable rows → empty `classDistribution {}` instead of the intended one-class `{NEUTRAL: N}` | Gave the test real price/volume variation + 200 rows so ≥80 usable rows survive and reach the **one-class** branch the test name describes. Pipeline behavior unchanged; test now truthfully exercises its scenario |

> Verified bug #5 is pre-existing via `git stash` on a clean `origin/main` checkout.

## 3. Subsystem Status

- **ML lifecycle:** dependencies (required/optional split) · train (precise dataset + dependency errors, sklearn-safe LogisticRegression, per-candidate isolation from #98/#100) · model/model-runs/promote/infer all return structured JSON, infer never 404. ✅
- **Historical data:** `symbols[]` + legacy `symbol`; canonical registry record (normalized on read); diagnostics; **new use-for-* selection contracts**. ✅
- **Backtesting:** accepts `datasetId`, returns `dataSource.type:"historical_dataset"`; precise dataset errors (covered by `historicalDatasetConsumers.test.js`). ✅
- **Correlation / Beta:** accept `datasetId`; return `null` never NaN; `not_enough_data` on no overlap. ✅
- **Providers:** backend source-of-truth; health/credentials/active/feed consistent (`providerState.test.js`). ✅
- **Portfolio / Risk:** safe JSON empty states for all routes. ✅
- **API contract:** JSON-only; `endpoint_not_found` 404; `internal_error` + `requestId`; `sanitizeJson` available. ✅

## 4. Tests Added

| File | Coverage |
|------|----------|
| `server/tests/datasetUsageRoutes.test.js` | **New.** use-for-ml/backtest/correlation: `dataset_required`, `dataset_not_found`, `dataset_csv_missing` (ml), JSON-only accepted for backtest, `dataset_file_missing`, ready+real datasetId, no `"datasetId":"undefined"` |
| `server/tests/mlRoutes.test.js` | Added: dependencies required/optional contract — optional-missing must not flip to `python_dependency_missing` |
| `server/ai/tests/test_minimal_train_pipeline.py` | Fixed one-class test data (now exercises the intended branch) |

## 5. Validation

| Command | Result |
|---|---|
| `npm run build` | ✅ |
| `npm test` (serial, `--test-concurrency=1`) | ✅ **76/76** |
| `python3 -m pytest server/ai/tests` | ✅ **218/218** |
| `python3 server/ai/train_pipeline.py --help` | ✅ |
| `npm run smoke:backend` | ✅ **16/16** (no 404/HTML/NaN/Infinity; unknown route → JSON 404; `use-for-ml` no-body → JSON 400) |

Results: `FULL_BACKEND_SMOKE_RESULTS.json`.

## 6. Remaining Risks / Manual Checks

1. **Frontend repo cannot be pushed from this environment** (proxy unreachable; MCP scoped to `reversal`). The frontend should call the new `use-for-*` endpoints; the backend contracts are ready and tested.
2. **Provider live connectivity** (Alpha Vantage / Yahoo realtime, `fallback_demo` persistence) needs real credentials + a browser session.
3. **Render deploy** must redeploy to pick up changes; then check `GET /api/ml/dependencies` → `ready` (or `ready_with_optional_missing`) and run a real training job.

## 7. Production Deployment Notes
No new env vars. `ML_PYTHON_BIN`/`PYTHON_BIN` remain optional. Post-deploy liveness: `GET /api/version`; ML readiness: `GET /api/ml/dependencies`.
