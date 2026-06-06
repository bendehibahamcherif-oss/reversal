# Full Platform Stabilization — Release Report

**Date:** 2026-06-06
**Branch:** `claude/feed-chart-routes-format-f6bKw`
**Scope:** Backend repo `reversal` (functional stabilization pass)

---

## 1. Executive Summary

This pass targeted the highest-severity, *verifiable* functional bugs across the
backend and validated the whole API surface against a release-gate smoke test.

The **scikit-learn `LogisticRegression(multi_class=…)` crash** that silently broke
*every* ML training run (sklearn 1.7+ removed the keyword; runtime is **1.8.0**) was
independently fixed and merged to `main` via **PR #98** while this branch was in
flight. After rebasing, this branch adopts #98's superset implementation
(`make_logistic_regression()` factory + per-model-type selection with fallbacks)
and contributes a dedicated **regression test** so the keyword can never be
reintroduced.

A full repo inventory confirmed large parts of the mission checklist were already
satisfied by prior PRs (#95 historical/dataset, #96 Python ML deps, #97/#98 ML
training): routes mounted, macro/beta NaN-safe via `sanitizeJson`, `/api/*` 404
handler present, dependency endpoint live. This branch closes the remaining
concrete gaps:

- **Global JSON error middleware** + **`/api/version`** (`server.js`).
- **Release-gate smoke harness** (`scripts/full-platform-smoke.js`).
- **LogisticRegression regression test** (`test_logreg_compat.py`).
- **Deterministic test execution** — fixed a pre-existing parallel-run race on the
  shared `datasets.json` registry that made `npm test` flaky (63/64).

**Result:** **64/64 Node tests** pass (serial) · Python regression + pipeline tests
pass · **18/18** full-platform smoke endpoints pass (no 404, no HTML, no NaN/Infinity).

---

## 2. Bugs Found

| # | Severity | Area | Bug | Owner |
|---|----------|------|-----|-------|
| 1 | **Critical** | ML training | `LogisticRegression(multi_class="auto")` crashes on sklearn ≥1.7; baseline failure aborted all candidates → every train returned `training_failed` | Fixed in **PR #98**; this branch adds a regression test |
| 2 | High | ML training | No per-candidate failure isolation | Fixed in **PR #98** (adopted on rebase) |
| 3 | Medium | API contract | No global JSON error middleware — an uncaught throw could fall through to Express's HTML error page | **This branch** |
| 4 | Low | API contract | No `/api/version` endpoint (referenced by smoke/release tooling) | **This branch** |
| 5 | Medium | Test/route disagreement | `historicalDatasetConsumers.test.js` asserted HTTP **200** for ML `dataset_not_found`, while the route + `mlRoutes.test.js` + the sibling backtest assertion use **404** | **This branch** |
| 6 | Medium | Test determinism | `npm test` was flaky (63/64): test files run in parallel and race on the shared on-disk `datasets.json` registry, clobbering the macro-overlap record | **This branch** |

---

## 3. Bugs Fixed

### Bug 1 + 2 — LogisticRegression crash & baseline isolation
Landed on `main` via **PR #98**, which uses a `make_logistic_regression()` factory
(`solver="lbfgs", class_weight="balanced"`, no `multi_class`) plus per-model-type
candidate selection with isolated try/except and structured per-model errors. This
branch **rebased onto and adopted** that implementation (resolving the overlap in
`server/ai/train_pipeline.py` in favor of #98's superset).

This branch's contribution here is a **regression test** (`test_logreg_compat.py`)
that (a) source-scans both pipeline files to assert no `multi_class` kwarg is ever
passed to `LogisticRegression(...)`, and (b) functionally fits the exact constructor
on 3-class data. The secondary pipeline `server/ai/training/train_pipeline.py` and
`backend_python.md` also had `multi_class` removed.

> **Note:** `roc_auc_score(..., multi_class="ovr")` calls were left untouched — that is a different, valid scikit-learn API and is *not* affected.

### Bug 3 — Global JSON error middleware
`server.js`: added a 4-arg Express error handler registered after all routes. Any uncaught error on `/api/*` now returns:
```json
{ "ok": false, "status": "<code>", "message": "...", "details": {}, "endpoint": "...", "method": "GET" }
```
The existing `/api/*` 404 handler was also normalized to `status: "endpoint_not_found"` with a human message.

### Bug 4 — `/api/version`
`server.js`: `GET /api/version` → `{ ok, service, version, node, uptimeSeconds }`.

### Bug 5 — Stale test assertion
`historicalDatasetConsumers.test.js`: corrected the ML `dataset_not_found` expectation from 200 → **404**, matching the documented dataset error contract and the sibling backtest test in the same file.

---

## 4. End-to-End Verification

**Synthetic CSV training run** (400 rows, horizon 5) through the *real* active pipeline:
```
STATUS: trained | modelType: xgboost | ok: True | warnings: []
```
Empty `warnings` confirms the LogisticRegression baseline now fits cleanly (previously it crashed first and blocked everything).

**`GET /api/ml/dependencies`** (live server):
```json
{ "ok": true, "status": "ready",
  "python": { "available": true, "version": "3.11.15" },
  "dependencies": { "numpy": true, "pandas": true, "sklearn": true, "joblib": true, "pyarrow": true, "xgboost": true },
  "missing": [], "pythonBin": "python3" }
```

---

## 5. Tests Added / Updated

| File | Change |
|------|--------|
| `server/ai/tests/test_logreg_compat.py` | **New.** (a) source-scan asserting no `multi_class` kwarg in any `LogisticRegression(...)` call across both pipelines; (b) functional fit of the exact version-safe constructor on 3-class data |
| `server/tests/historicalDatasetConsumers.test.js` | Fixed stale `dataset_not_found` assertion (200 → 404) |
| `scripts/full-platform-smoke.js` | **New.** Release-gate smoke: boots `server.js`, validates 18 endpoints for valid-JSON / no-HTML / no-NaN-Infinity / required keys, plus a negative-control unknown route that must return JSON 404 |
| `package.json` | Added `npm run smoke:full`; made `npm test` deterministic via `--test-concurrency=1` (fixes the shared-registry race) |

---

## 6. Validation Results

| Command | Result |
|---------|--------|
| `npm run build` (`node --check`) | ✅ pass |
| `npm test` (Node, serial) | ✅ **64/64** pass |
| `python3 -m pytest server/ai/tests/test_logreg_compat.py server/ai/tests/test_minimal_train_pipeline.py` | ✅ 4/4 pass |
| `python3 server/ai/train_pipeline.py --help` | ✅ ok |
| Synthetic end-to-end train | ✅ `status: trained` |
| `npm run smoke:full` | ✅ **18/18** endpoints pass |

Smoke coverage: `/api/version`, `/api/ml/dependencies|model|model-runs|drift|predictions|feature-importance|model-card`, `/api/historical/providers|datasets`, `/api/providers/health|active`, `/api/feed/status`, `/api/portfolio/summary`, `/api/risk/summary`, `/api/macro/correlation`, `/api/macro/beta`, and an unknown-route negative control. Results written to `FULL_PLATFORM_SMOKE_RESULTS.json`.

---

## 7. Already-Satisfied Areas (confirmed by inventory, no change needed)

- **Routes mounted:** all 35 routers mounted via `runtimeIntegration.js`; portfolio/risk/macro/provider/feed groups present.
- **NaN/Infinity safety:** `macroRoutes` beta/correlation return `null` (never NaN) and every response passes through `sanitizeJson()` which coerces non-finite numbers to `null`.
- **404 handling:** `/api/*` catch-all returns JSON.
- **Dataset → consumer propagation (backend):** `historicalDatasetConsumers.test.js` confirms ML train, backtest (`dataSource.type: historical_dataset`, `dataSource.datasetId`), and macro correlation/beta all accept `datasetId` with the documented error priority (`dataset_not_found` → `dataset_file_missing` → …).
- **Python ML deps on Render:** `render.yaml` build installs `requirements-ml.txt`; `/api/ml/dependencies` reports readiness (PR #96).
- **ML JSON empty states:** `/api/ml/model|drift|model-runs|predictions|feature-importance|model-card` return stable JSON (covered by `mlRoutes.test.js`).

---

## 8. Remaining Risks / Manual Checks Still Needed

1. **Frontend repo (`intraday-reversal-engine`) push is blocked in this environment** — its git proxy is unreachable from the remote session, and the GitHub MCP tools are scoped to `reversal` only. The frontend dataset→training wiring (datasetId in the AI Lab payload, `getDatasetId` helper, AILab display) was implemented and committed **locally** in a prior session (`fix(ml): wire selected historical dataset into AI Lab training payload`) but must be pushed from a machine with access. Backtest/Correlation "Use dataset" UI actions should be verified there; the **backend already accepts `datasetId`** for all three consumers (proven by tests).
2. **Provider live connectivity** (Alpha Vantage / Yahoo runtime state, `fallback_demo` persistence) requires real credentials + a browser session to validate end-to-end; not reproducible headless here.
3. **Render deployment** must redeploy to pick up the `render.yaml` build change; then re-check `GET /api/ml/dependencies` → `ready` and run a real training job.
4. **WebSocket degraded-mode UX** is a frontend concern; backend WS emitter is unaffected by this pass.

---

## 9. Production Deployment Notes

- No new runtime env vars required. `ML_PYTHON_BIN` / `PYTHON_BIN` remain optional overrides (default `python3`).
- After deploy: `GET /api/version` (liveness), `GET /api/ml/dependencies` (should be `ready`), then a training run via AI Lab with a selected historical dataset.
