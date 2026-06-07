# Backend Production Bug Discovery Report

Generated: 2026-06-07

## 1. Route Discovery Summary

`node scripts/backend-route-discovery.js` scanned Express mounts, router declarations, runtime integration, and aliases. It found all 49 required production API contracts mounted. Results are recorded in `BACKEND_ROUTE_DISCOVERY_RESULTS.json`.

## 2. API Contract Crawler Results

`node scripts/api-contract-crawler.js` started a local backend and crawled every required route with safe sample parameters. It verified JSON content type, valid JSON bodies, no HTML, no raw `NaN`/`Infinity`/`undefined`, and expected top-level contract keys. Results are recorded in `API_CONTRACT_CRAWLER_RESULTS.json`.

## 3. Payload Fuzzer Results

`node scripts/backend-payload-fuzzer.js` fuzzed critical POST endpoints with missing, null, malformed, sentinel, dataset, symbol, provider, and model payloads. All 170 malformed payload requests stayed JSON-safe and crash-free. Results are recorded in `BACKEND_PAYLOAD_FUZZ_RESULTS.json`.

## 4. Production Smoke Results

`node scripts/production-api-contract-smoke.js` writes `PRODUCTION_API_CONTRACT_SMOKE_RESULTS.json`. In this environment it was skipped because `API_BASE` was not provided. CI/Render rerun command:

```bash
API_BASE=https://reversal.onrender.com node scripts/production-api-contract-smoke.js
```

## 5. Unknown Bugs Discovered

- `/api/feeds/tick/:symbol` and `/api/feeds/candle/:symbol` could block while provider polling retried Yahoo requests.
- JSON parse errors for primitive JSON bodies such as `null` were reported as `internal_error` instead of `invalid_payload`.
- Historical download accepted malformed timeframes/dates far enough to call providers.
- Historical CSV-backed datasets could be selected for backtest/correlation but CSV reading attempted JSON parsing.
- There was no automated release gate proving all frontend-consumed backend routes were mounted, JSON-only, finite, and deterministic.

## 6. Root Causes Fixed

- Added JSON-only API error middleware that maps body parser failures to structured `invalid_payload` and prevents Express HTML for `/api/*`.
- Hardened `sanitizeJson` for circular references, `Map`, `Set`, `Buffer`, `BigInt`, `Date`, `Error`, and non-finite numbers.
- Added cached, non-blocking feed tick/candle contracts unless live polling is explicitly requested with `live=1`.
- Added historical payload validation for timeframe, date shape, and `fallback_demo` provider rejection.
- Added CSV parsing for historical dataset consumers.
- Added precise sentinel rejection for `undefined`/`null` dataset IDs in historical, ML, and backtest flows.

## 7. ML Training Contracts

ML dependency, health, model, run registry, prediction, feature importance, drift, model-card, train, promote, and infer routes are included in route discovery and crawler coverage. Training resolves `datasetId` through the registry before invoking Python and reports precise dataset errors.

## 8. Historical Dataset Contracts

Historical download accepts symbol arrays and legacy strings, validates symbols/timeframes/dates/providers, returns a top-level `datasetId` on success, and rejects demo fallback as real historical generation. Use-for endpoints reject missing/undefined/null IDs and validate registry/file state before returning `ready`.

## 9. Backtest Contracts

`POST /api/backtest/run` requires a real `datasetId`, rejects `fallback_demo`, loads historical datasets without refetching providers, and returns precise dataset errors or a historical dataset data source.

## 10. Macro/Beta Contracts

Macro beta and correlation routes accept `datasetId`, return not-enough-data shapes when no dataset is provided, and sanitize all finite calculations so beta, r2, and matrix cells are numbers or null.

## 11. Provider Contracts

Provider health, credentials, active provider, and feed status contracts are part of crawler and fuzzer coverage. Existing provider regression tests verify Alpha Vantage credential configuration, persisted fallback-demo disablement, Yahoo delayed status, and active-provider consistency.

## 12. Portfolio/Risk Contracts

Portfolio and risk endpoints are included in crawler coverage and regression tests. Empty positions, zero PnL/exposure, nullable VaR/ES equivalents, empty drawdown/history, and empty alerts are JSON-safe.

## 13. JSON Sanitizer/Error Middleware

`server/utils/apiResponse.js` now sanitizes non-finite and complex runtime values. `server/middleware/jsonOnlyApiErrors.js` centralizes `/api/*` unknown endpoint and thrown error handling.

## 14. Tests Added/Updated

Updated API contract sanitizer regression expectations for circular references and added automated script gates for route discovery, local API crawling, payload fuzzing, production smoke, and production readiness orchestration.

## 15. Final Command Results

- PASS: `npm test`
- PASS: `npm run build`
- PASS: `node scripts/backend-route-discovery.js`
- PASS: `node scripts/api-contract-crawler.js`
- PASS: `node scripts/backend-payload-fuzzer.js`
- PASS: `node scripts/full-backend-smoke.js`
- PASS: `node scripts/run-backend-production-readiness.js`
- WARN: `python3 -m pytest server/ai/tests -v` could not collect tests because this environment lacks Python packages `numpy` and `joblib`.
- PASS: `python3 server/ai/train_pipeline.py --help`
- WARN: `npm run lint` is not defined in `package.json`.
- WARN: `npm run typecheck` is not defined in `package.json`.

## 16. Remaining Risks

- Production API verification still needs a deployed rerun with `API_BASE=https://reversal.onrender.com`.
- Python ML tests require installing runtime ML dependencies (`numpy`, `joblib`, and related packages) in the execution environment.
- Live feed polling remains explicit via `live=1`; frontend consumers should rely on the non-blocking cached contract for render-safe status.

## 17. Deployment Notes

Run the local gate before deployment:

```bash
node scripts/run-backend-production-readiness.js
```

Run deployed verification after deployment:

```bash
API_BASE=https://reversal.onrender.com node scripts/production-api-contract-smoke.js
```
