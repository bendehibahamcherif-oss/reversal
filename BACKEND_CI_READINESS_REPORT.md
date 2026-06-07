# Backend CI Readiness Report

**Date:** 2026-06-07 · **Branch:** `claude/feed-chart-routes-format-f6bKw` · **Repo:** `reversal`

## Summary

This report documents which scripts and checks are available for the
`Backend Production Readiness` GitHub Actions workflow, and which are missing.
The workflow runs unconditionally; missing scripts are skipped with a logged
message and `continue-on-error: true` — they do **not** block CI.

## npm Scripts

| Script | Status | Command |
|--------|--------|---------|
| `test` | ✅ Present | `node --test --test-concurrency=1 server/tests/*.test.js` |
| `build` | ✅ Present | `node --check server/index.cjs && node --check server.js` |
| `smoke:backend` | ✅ Present | `node scripts/full-backend-smoke.js` |
| `smoke:full` | ✅ Present | `node scripts/full-platform-smoke.js` |
| `lint` | ❌ **Not defined** | No ESLint/Biome/Prettier config wired into package.json scripts |
| `typecheck` | ❌ **Not defined** | Project uses plain JS (no TypeScript); no `tsc` or jsconfig check wired |

## scripts/ Directory

| Script | Status | Notes |
|--------|--------|-------|
| `scripts/full-backend-smoke.js` | ✅ Present | 16-endpoint release gate; primary CI gate |
| `scripts/full-platform-smoke.js` | ✅ Present | 18-endpoint gate (older, broader) |
| `scripts/production-api-smoke.js` | ✅ Present | Endpoint ping script |
| `scripts/platform-smoke.js` | ✅ Present | Earlier smoke iteration |
| `scripts/ml-train-smoke.js` | ✅ Present | ML training smoke |
| `scripts/check-ml-deps.js` | ✅ Present | Python dependency checker |
| `scripts/create-synthetic-ml-dataset.js` | ✅ Present | Dev utility |
| `scripts/ml-train-debug.js` | ✅ Present | Dev utility |
| `scripts/backend-route-discovery.js` | ❌ **Missing** | Would auto-enumerate all mounted routes |
| `scripts/api-contract-crawler.js` | ❌ **Missing** | Would crawl all endpoints and validate contract shape |
| `scripts/backend-payload-fuzzer.js` | ❌ **Missing** | Would fuzz request payloads for unhandled errors |
| `scripts/run-backend-production-readiness.js` | ❌ **Missing** | Would orchestrate all readiness checks |

## Python

| Check | Status | Notes |
|-------|--------|-------|
| `python3 server/ai/train_pipeline.py --help` | ✅ | Validates argument parsing entrypoint |
| `python3 -m pytest server/ai/tests -v` | ✅ | 218 tests as of 2026-06-06 |
| `requirements-ml.txt` | ✅ Present | numpy, pandas, scikit-learn, joblib, xgboost, lightgbm, pyarrow |

## CI Behavior

- **Blocking failures** (exit non-zero, fail the workflow run):
  - `npm test`
  - `npm run build`
  - `python3 server/ai/train_pipeline.py --help`
  - `python3 -m pytest server/ai/tests -v`
  - `npm run smoke:backend`

- **Non-blocking** (`continue-on-error: true`, logged but do not fail the run):
  - `npm run smoke:full` — runs but failure is advisory
  - `scripts/backend-route-discovery.js` — skipped (file missing)
  - `scripts/api-contract-crawler.js` — skipped (file missing)
  - `scripts/backend-payload-fuzzer.js` — skipped (file missing)
  - `scripts/run-backend-production-readiness.js` — skipped (file missing)
  - `npm run lint` — skipped (script not in package.json)
  - `npm run typecheck` — skipped (script not in package.json)

## Recommended Next Steps

1. **Add ESLint** (`eslint.config.js` + `"lint": "eslint ."` in package.json) to promote the lint step to blocking.
2. **Implement `scripts/backend-route-discovery.js`** — crawl `server/api/*.js` and emit a JSON route manifest; diff against `BACKEND_ROUTE_INVENTORY.md` in CI.
3. **Implement `scripts/api-contract-crawler.js`** — boot server on ephemeral port, hit all routes, assert JSON + `ok` field + no NaN/Infinity.
4. **Implement `scripts/backend-payload-fuzzer.js`** — send malformed payloads to mutation endpoints and assert structured error responses.
5. **Implement `scripts/run-backend-production-readiness.js`** — orchestrate steps 2–4 and write a consolidated `BACKEND_READINESS_REPORT.json` artifact.
