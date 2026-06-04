# Global Platform Fix Report

Date: 2026-06-04  
Branch: `claude/feed-chart-routes-format-f6bKw`  
Backend repo: `bendehibahamcherif-oss/reversal`

---

## Executive Summary

Complete backend stabilization across 4 phases (Missions A, B, C). All P0 and P1 bugs are fixed. Zero frontend routes now call a dead backend endpoint.

---

## Phase A — Portfolio API Format (P0)

**Bug:** `d.toFixed is not a function` crash in React (production).  
**Root cause:** `GET /api/portfolio/drawdown` returned `series` as an array of objects; frontend called `.map(d => d.toFixed(1))` → `undefined.toFixed()`.  
**Fix (commit 78abb68):** Normalized `series` to an array of plain numbers in `portfolioRoutes.js`. Each item mapped via `Number(s.drawdownPct ?? s.drawdown ?? 0)`.  
**Proof:** `drawdown.series` is now always `number[]`.

---

## Phase B — Provider/Credential State Consistency (P0)

**Commit:** 906e425

### B1 — fallback_demo impossible to uncheck
- **Root cause:** `feedManager.resolveActiveState()` lines 72-75 unconditionally re-added `fallback_demo` if runtime was valid, even when explicitly disabled.
- **Fix:** Removed the forced re-addition block. `resolveActiveState` now respects explicit disable.

### B2 — Credentials 404 for `alphaVantage`
- **Root cause:** `providerCredentialRoutes.js` called `.toLowerCase()` on `providerId` before `feedManager.getProvider()`, but `providerRegistry` uses camelCase keys.
- **Fix:** Removed `.toLowerCase()` in `providerCredentialRoutes.js`. Added `feedManager._getProviderByAnyCase(id)` helper that does case-insensitive fallback internally.

### B3 — Alpha Vantage shows "missing_credentials" after save
- **Root cause:** `feedStore.saveCredentials` reads `result?.credentialsStatus || 'missing_credentials'`, but save responses didn't include `credentialsStatus`.
- **Fix:** Added `credentialsStatus: meta.configured ? 'configured' : 'missing_credentials'` to all credential save/delete responses in both `feedRoutes.js` and `providerCredentialRoutes.js`.

### B4 — `/api/providers/health` missing provider credential context
- **Root cause:** Health endpoint returned stream engine state but no credential/capability data per provider.
- **Fix:** Added `canonicalProviders[]` array to `marketStreamRoutes.js` health handler. Each entry includes `credentialStatus`, `runtimeStatus`, `capabilities`, `active`, `connected`.

### B5 — `/api/feeds/providers/active` missing `ok` and `activeProviders`
- **Fix:** Added `ok: true` and `activeProviders` alias to GET/POST active responses.

---

## Phase C — Global Audit & Full Stabilization

### C1 — ML 404s (commits 78abb68, cd301e0)

| Route | Status |
|-------|--------|
| `GET /api/ml/model-runs` | ✅ Added (alias of training-runs) |
| `GET /api/ml/predictions` | ✅ Added |
| `GET /api/ml/signal/:symbol` | ✅ Added — stable empty state: `{ ok, symbol, signal: null, status: 'no_cached_signal' }` |
| `GET /api/ml/feature-importance` | ✅ Added — reads model metadata; returns `{ ok, features: [], count: 0 }` without champion |
| `GET /api/ml/drift` | ✅ Added — returns `{ ok, drift: { psi: {}, status: 'not_enough_data' } }` |

### C2 — Risk routes missing entirely (commit cd301e0)

Created `server/api/riskRoutes.js` — new router mounted at `/api/risk`:

| Route | Response shape |
|-------|---------------|
| `GET /api/risk/summary` | `{ ok, mode, risk: { var95, grossExposure, maxDrawdown, totalPnL, positionCount, status, ... } }` |
| `GET /api/risk/exposure` | `{ ok, mode, exposure: { gross, net, long, short, leverage } }` |
| `GET /api/risk/drawdown` | `{ ok, mode, drawdown: { series[], currentDrawdown, maxDrawdown, maxDrawdownPct } }` |
| `GET /api/risk/var` | `{ ok, mode, var, varPct, confidence, horizon }` |
| `GET /api/risk/limits` | `{ ok, limits: { status: 'not_configured', killSwitchActive: false } }` |
| `GET /api/risk/alerts` | `{ ok, mode, alerts: [], count: 0 }` |

All routes degrade gracefully (no positions → zero state, not 404).

### C3 — Portfolio `ok` field missing (commit cd301e0)

`replyWithEngineResult` in `portfolioRoutes.js` previously returned only `success: true`. Now returns `{ ok: true, success: true, ...result }`.

---

## Tests Added (commit 3ecb177)

Extended `scripts/server-smoke.cjs` with 18 new checks covering all fixed routes:

| Test | Assertion |
|------|-----------|
| `GET /api/risk/summary?mode=paper` | `ok:true`, `risk.grossExposure` is number, `risk.status` present |
| `GET /api/risk/summary?mode=live` | HTTP 503 with `error` field |
| `GET /api/risk/exposure?mode=paper` | `ok:true`, `exposure.gross` is number |
| `GET /api/risk/drawdown?mode=paper` | `ok:true`, `drawdown.series` is array |
| `GET /api/risk/var?mode=paper` | `ok:true`, `var`, `confidence`, `horizon` are numbers |
| `GET /api/risk/limits` | `ok:true`, `limits.status === 'not_configured'` |
| `GET /api/risk/alerts?mode=paper` | `ok:true`, `alerts` is array |
| `GET /api/ml/health` | `ok:true`, `workerAlive` is boolean |
| `GET /api/ml/model` | `ok:true` |
| `GET /api/ml/predictions` | `ok:true`, `predictions` is array |
| `GET /api/ml/model-runs` | `ok:true`, `activeJobs` is array |
| `GET /api/ml/model-card` | `ok:true` |
| `GET /api/ml/feature-importance` | `ok:true`, `features` is array, `count` is number |
| `GET /api/ml/drift` | `ok:true`, `drift.status === 'not_enough_data'` |
| `GET /api/ml/signal/SPY` | `ok:true`, `symbol === 'SPY'`, `signal === null` |
| `GET /api/providers/health` | `ok:true`, `canonicalProviders` is non-empty array with `id`, `credentialStatus`, `capabilities` |
| `GET /api/feeds/providers/active` | `ok:true`, `activeProviders` is array |
| `POST /api/feeds/providers/:id/credentials` | response includes `credentialsStatus: 'configured'` |
| `DELETE /api/feeds/providers/:id/credentials` | response includes `credentialsStatus: 'missing_credentials'` |
| `GET /api/portfolio/positions` | now also checks `ok:true` |

---

## Residual Issues (Frontend — cannot be pushed from this repo)

These require changes in `bendehibahamcherif-oss/intraday-reversal-engine`:

| Issue | File | Fix |
|-------|------|-----|
| `feedStore.saveCredentials` defaults to `'missing_credentials'` if key absent | `src/store/feedStore.js` | Backend now returns `credentialsStatus` — frontend should read it directly |
| `LiveDataWorkspace.parsedProviders` mixes UI and backend state | `src/workspaces/LiveDataWorkspace.jsx` | Display only `activeProviders` from backend |
| `marketRuntimeStore` duplicates `activeProviders` | `src/store/marketRuntimeStore.js` | Remove — `feedStore` is the single source of truth |
| `localStorage` can override backend state on reload | `feedStore` persist middleware | Re-fetch backend after hydration |

---

## Commit History (this branch)

```
3ecb177  test(smoke): add coverage for risk, ML worker, and provider health routes
cd301e0  fix(api): add missing ML/Risk routes and fix portfolio ok field
906e425  fix: provider state consistency — credentials, fallback_demo, case-insensitive lookup
78abb68  fix: align portfolio/ML API response formats with frontend contracts
4092998  fix: add missing portfolio pnl/exposure and ml predictions endpoints
```

---

## Definition of Done — Checklist

- [x] `GET /api/portfolio/drawdown` returns `series: number[]` — no more `toFixed` crash
- [x] fallback_demo can be disabled by the user
- [x] `POST /api/feeds/providers/:id/credentials` returns `credentialsStatus`
- [x] `DELETE /api/feeds/providers/:id/credentials` returns `credentialsStatus: 'missing_credentials'`
- [x] Provider lookup is case-insensitive (`alphaVantage`, `alphavantage`, `AlphaVantage` all work)
- [x] `GET /api/providers/health` returns `canonicalProviders[]` with credential/capability data
- [x] `GET /api/feeds/providers/active` returns `ok: true` and `activeProviders[]`
- [x] `GET /api/ml/signal/:symbol` → 200 stable empty state
- [x] `GET /api/ml/feature-importance` → 200 with `features: []`
- [x] `GET /api/ml/drift` → 200 with `status: 'not_enough_data'`
- [x] All 6 `/api/risk/*` routes exist and return correct shapes
- [x] `GET /api/portfolio/*` returns `ok: true` alongside `success: true`
- [x] Smoke test covers all new and fixed routes
- [x] All modified files pass `node --check` syntax validation
- [x] No existing tests broken
