# Backend CI Readiness Report

**Date:** 2026-06-07 · **Branch:** `claude/feed-chart-routes-format-f6bKw` · **Repo:** `reversal`

## Incident: EACCES permission denied for /var/data

### Root Cause

Backend stores hardcoded `/var/data` as the default storage path (SQLite databases,
JSON registries, alert files, ML model artifacts). GitHub Actions CI runners cannot
write to `/var/data` — it is a Render-specific persistent-disk mount that only
exists on deployed Render instances. Running `npm test` in CI therefore crashed at
module load time:

```
EACCES: permission denied, mkdir '/var/data'
Failing file: server/backtest/backtestStore.js
```

The same crash would affect any environment that does not have `/var/data` — local
development without that directory, Docker builds, and any other CI provider.

### Fix

Created a central storage path helper and migrated all stores to use it:

**`server/utils/storagePaths.js`** — path resolution priority:
1. `DATA_DIR` env var (explicit; set `DATA_DIR=/var/data` in Render production)
2. `NODE_ENV=test` **or** `CI=true` → `./tmp/test-data` (writable repo-local path)
3. Default → `./data` (local development)

`/var/data` is never hardcoded anywhere in the codebase. It is only reached if the
operator explicitly sets `DATA_DIR=/var/data`, which is correct for Render.

### Files Fixed

| File | Change |
|------|--------|
| `server/utils/storagePaths.js` | **NEW** — central `DATA_DIR` resolver + `ensureDataDir()` + `dataPath()` |
| `server/backtest/backtestStore.js` | Replaced hardcoded `DATA_DIR \|\| '/var/data'` with import |
| `server/alerts/AlertStore.js` | Replaced hardcoded `'/var/data/alerts.json'` with `dataPath()` |
| `server/alerts/AlertHistoryStore.js` | Replaced hardcoded `'/var/data/alertHistory.json'` with `dataPath()` |
| `server/ai/registry/modelRegistryService.js` | Replaced hardcoded `DATA_DIR \|\| '/var/data'` with import |
| `server/ai/drift/psiEngine.js` | Replaced hardcoded `DATA_DIR \|\| '/var/data'` with import |
| `server/execution/executionStore.js` | Replaced hardcoded `DATA_DIR \|\| '/var/data'` with import |
| `server/institutional/institutionalStore.js` | Replaced hardcoded `DATA_DIR \|\| '/var/data'` with import |
| `server/oms/omsStore.js` | Replaced hardcoded `DATA_DIR \|\| '/var/data'` with import |
| `db.js` | Replaced `DB_PATH \|\| '/var/data/reversal.db'` with `join(DATA_DIR, 'reversal.db')` |
| `.github/workflows/backend-production-readiness.yml` | Added `DATA_DIR`, `NODE_ENV=test`, and `mkdir -p "$DATA_DIR"` step |

### Paths That Were Already Safe (unchanged)

| File | Pattern |
|------|---------|
| `server/feeds/providers/credentialStore.js` | `process.cwd()/server/persistence/secure` |
| `server/persistence/activeProviderStore.js` | `process.cwd()/server/persistence/secure` |
| `server/historical/historicalDatasetRegistry.js` | `__dirname/../data/historical` |
| `server/historical/historicalDataService.js` | Relative to registry |

### Storage Path Rules

| Environment | How to configure | Resolved path |
|-------------|-----------------|---------------|
| Render production | Set `DATA_DIR=/var/data` in env | `/var/data` |
| GitHub Actions CI | `DATA_DIR=${{ github.workspace }}/tmp/backend-data` + `NODE_ENV: test` set in workflow | `<workspace>/tmp/backend-data` |
| Local development | No env vars needed | `./data` (project-relative) |
| Tests (`npm test`) | `NODE_ENV=test` (set automatically by workflow) | `./tmp/test-data` |
| Any custom path | Set `DATA_DIR=/your/path` | `/your/path` |

---

## Command Results (2026-06-07)

| Command | Result |
|---------|--------|
| `NODE_ENV=test npm test` | ✅ **82/82** (77 top-level, 6 storagePaths sub-tests) |
| `NODE_ENV=test DATA_DIR=./tmp/backend-data npm run smoke:backend` | ✅ **16/16** |
| `npm run build` | ✅ |
| `python3 server/ai/train_pipeline.py --help` | ✅ |
| `python3 -m pytest server/ai/tests -v` | ✅ **218/218** |
| `node scripts/backend-route-discovery.js` | ❌ Script not yet implemented — see below |
| `node scripts/api-contract-crawler.js` | ❌ Script not yet implemented — see below |
| `node scripts/backend-payload-fuzzer.js` | ❌ Script not yet implemented — see below |
| `node scripts/run-backend-production-readiness.js` | ❌ Script not yet implemented — see below |

---

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
| `python3 -m pytest server/ai/tests -v` | ✅ | 218 tests |
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

1. **Add `DATA_DIR=/var/data` to Render environment variables** so that production
   continues to write to the Render persistent disk exactly as before.
2. **Add ESLint** (`eslint.config.js` + `"lint": "eslint ."` in package.json) to
   promote the lint step to blocking.
3. **Implement `scripts/backend-route-discovery.js`** — crawl `server/api/*.js` and
   emit a JSON route manifest; diff against `BACKEND_ROUTE_INVENTORY.md` in CI.
4. **Implement `scripts/api-contract-crawler.js`** — boot server on ephemeral port,
   hit all routes, assert JSON + `ok` field + no NaN/Infinity.
5. **Implement `scripts/backend-payload-fuzzer.js`** — send malformed payloads to
   mutation endpoints and assert structured error responses.
6. **Implement `scripts/run-backend-production-readiness.js`** — orchestrate steps
   3–5 and write a consolidated `BACKEND_READINESS_REPORT.json` artifact.
