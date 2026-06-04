# Functional Bug Fix Report

Date: 2026-06-04  
Branch: `claude/feed-chart-routes-format-f6bKw`  
Backend repo: `bendehibahamcherif-oss/reversal`

---

## 1. Root Causes

### Bug 1 — ML endpoints showing "Endpoint not available"

**Root cause A**: Routes `/api/ml/signal/:symbol`, `/api/ml/feature-importance`, `/api/ml/drift` were absent from the backend. Frontend `api.js` maps HTTP 404 → throws `Error("Endpoint not available")`. mlStore catches it and sets `modelInfoError / driftError / ...Error = "Endpoint not available"`.

**Root cause B**: `/api/ml/model` was returning HTTP 404 when `model_metadata.json` didn't exist. Frontend threw → "Endpoint not available" in ModelHealthCard.

**Root cause C**: Response format mismatches. Frontend mlStore reads `data.champion` for model, `data.models || []` for runs, `data.modelCard` for model-card — backend returned `metadata`, `activeJobs`, `content`. Silent empty-array fallbacks masked the mismatch but downstream rendering may not have rendered correctly.

### Bug 2 — fallback_demo impossible to disable

**Root cause A — `resolveActiveState` stale validity check** (most critical): The validity filter inside `resolveActiveState` called `this.getRuntimeState(id).valid`, which internally reads `this.enabledByProvider[id]` — the OLD instance state. When a user saves `providers: ['yahoo']`, the function builds `normalizedEnabled = { yahoo: true, fallback_demo: false }`, but then checks validity against the OLD state where `this.enabledByProvider.yahoo = false` (because fallback_demo had been forced active previously and yahoo was not). Yahoo fails the validity check → `validProviders = []` → backend falls back to `[DEFAULT_FALLBACK_PROVIDER]`.

**Root cause B — `setActiveProviders` stale merge**: When `providers: ['yahoo']` is passed without `enabledByProvider`, the merge is `{ ...this.enabledByProvider, ...{} }` — old state wins. If `this.enabledByProvider.fallback_demo = true` from a previous forced addition, fallback_demo stays enabled even though the user explicitly sent `providers: ['yahoo']`.

**Root cause C — (frontend, read-only)**: `LiveDataWorkspace.parsedProviders` merges `activeProviders + selectedProviders + feedStatus.activeProviders`, accumulating stale UI draft state with backend state. Cannot fix from this repo.

### Bug 3 — Yahoo shown as "NOT CONNECTED"

**Root cause**: `yahooProvider.status()` returned `{ status: 'fallback_delayed', connected: false }`. The `canonicalProviders` construction used `runtimeStatus: p.status` → `'fallback_delayed'`. `ProviderDiagnosticsPanel.jsx` reads `canonical.runtimeStatus` and displays it. `'fallback_delayed'` has no recognized display mapping → shown as unknown/error state. Yahoo is a REST delayed provider and is "not connected" in the WebSocket sense, but IS delivering data.

---

## 2. ML Endpoint Fixes

### 2a — Missing routes (previously fixed in PR #84)
All three routes were added to `server/api/mlRoutes.js`:
- `GET /api/ml/signal/:symbol` → `{ ok, symbol, signal: null, status: 'no_cached_signal' }`
- `GET /api/ml/feature-importance` → `{ ok, features: [], count: 0, status: 'no_champion' }`
- `GET /api/ml/drift` → `{ ok, drift: { status: 'not_enough_data', psi: {} } }`

### 2b — Response format additions (this fix)

**`GET /api/ml/model`** — added `champion`, `challengers`, `status` fields:
```json
// No trained model:
{ "ok": true, "metadata": null, "champion": null, "challengers": [], "status": "no_model" }
// Model loaded:
{ "ok": true, "metadata": {...}, "champion": {...}, "challengers": [], "status": "model_loaded" }
```

**`GET /api/ml/model-runs`** — added `runs` and `models` aliases:
```json
{ "ok": true, "activeJobs": [], "runs": [], "models": [], "count": 0 }
```

**`GET /api/ml/model-card`** — added `modelCard` alias and `status` field:
```json
// No card: { "ok": true, "content": null, "modelCard": null, "status": "not_available" }
// Has card: { "ok": true, "content": "...", "modelCard": "...", "status": "available" }
```

---

## 3. Provider Selection Fixes

### Fix A — `resolveActiveState` validity check (`server/feeds/feedManager.js`)

**Before**: Used `this.getRuntimeState(id).valid` which internally checks `this.enabledByProvider[id]` (stale old state).

**After**: Extracted `isTechValid(id)` helper that checks only `providerInitialized && usable && credentialLoaded` — deliberately skips the `enabled` field since `normalizedEnabled[id]` (the caller's intent) is already checked in the preceding filter step.

```js
const isTechValid = (id) => {
  const rt = this.validateProviderRuntime(id);
  return rt.providerInitialized && rt.usable && rt.credentialLoaded;
};
const validProviders = orderedRequested.filter((id) => normalizedEnabled[id]).filter((id) => isTechValid(id));
const fallbackOrdered = available.filter((id) => normalizedEnabled[id] && isTechValid(id));
```

### Fix B — `setActiveProviders` enabledByProvider derivation (`server/feeds/feedManager.js`)

**Before**: Merged incoming `enabledByProvider` with `this.enabledByProvider` — if caller sent `providers: ['yahoo']` without `enabledByProvider`, stale state persisted.

**After**: When `providers` array is explicitly passed and non-empty, derive the enabled state for ALL registered providers from it first — providers absent from the array are set to `false`:

```js
if (Array.isArray(providers) && providers.length > 0) {
  for (const id of providerRegistry.list().map((p) => p.id)) {
    baseEnabled[id] = providers.includes(id);
  }
}
const mergedEnabled = { ...baseEnabled, ...(enabledByProvider || {}) };
```

### Fix C — Empty selection validation (`server/api/feedRoutes.js`)

`POST /api/feeds/providers/active` with `{ providers: [] }` now returns:
```json
HTTP 400
{ "ok": false, "success": false, "error": { "code": "NO_PROVIDER_SELECTED", "message": "Select at least one provider." } }
```

---

## 4. fallback_demo Persistence Fix

Covered by Fixes A and B above. The combination of:
1. `isTechValid` not using stale `this.enabledByProvider`
2. `setActiveProviders` deriving `baseEnabled` from the explicit `providers` array

ensures that `POST /api/feeds/providers/active` with `{ providers: ['yahoo'] }` produces:
- `enabledByProvider = { yahoo: true, fallback_demo: false, ... }`  
- `resolveActiveState` includes yahoo (tech-valid) and excludes fallback_demo (disabled)
- Result: `activeProviders = ['yahoo']` persisted to disk

After server restart, `restoreActiveProviderState` loads the persisted state → same result.

---

## 5. LiveData Status Consistency Fix

### Fix D — Yahoo `runtimeStatus` normalization (`server/feeds/providers/yahooProvider.js`)

Changed `status()` return from `{ status: 'fallback_delayed' }` to `{ status: 'delayed', sourceType: 'delayed_rest' }`.

### Fix E — Canonical providers normalization (`server/api/marketStreamRoutes.js`)

Added normalization in `canonicalProviders` construction:
- `runtimeStatus = rawStatus === 'fallback_delayed' ? 'delayed' : rawStatus` — defensive for any residual values
- Added `sourceType` field: `'delayed_rest'` | `'demo'` | `'realtime'` | `'market_data'`

### Fix F — Feed status enrichment (`server/api/feedRoutes.js`)

`GET /api/feeds/status` now returns enriched statuses with:
- `sourceType` — `'delayed_rest'` for yahoo, `'demo'` for fallback_demo, etc.
- `status` — normalized (`'fallback_delayed'` → `'delayed'`)

Frontend consuming `feedStatus.statuses[].sourceType === 'delayed_rest'` can now show "DELAYED" instead of inferring broken from `connected: false`.

---

## 6. Files Changed

| File | Change |
|------|--------|
| `server/feeds/feedManager.js` | `resolveActiveState`: `isTechValid` helper; `setActiveProviders`: derive `baseEnabled` from providers array |
| `server/feeds/providers/yahooProvider.js` | `status()` returns `status: 'delayed'`, `sourceType: 'delayed_rest'` |
| `server/api/marketStreamRoutes.js` | `canonicalProviders`: normalize `runtimeStatus`, add `sourceType` |
| `server/api/feedRoutes.js` | Status enrichment (`sourceType`, normalized status); empty-providers 400 validation |
| `server/api/mlRoutes.js` | `/model`: add `champion`, `challengers`, `status`; `/model-runs`: add `runs`, `models` aliases; `/model-card`: add `modelCard`, `status` |
| `scripts/server-smoke.cjs` | New checks: `_feedsEmptyProvidersCheck`, `_feedsYahooOnlyCheck`, extended `_mlWorkerModelCheck`, `_mlWorkerRunsCheck`, `_mlWorkerCardCheck`, `_providersHealthCheck` with `sourceType`/runtimeStatus assertions |

---

## 7. Tests Added

New smoke checks (in addition to those from PR #84):

| Check | Assertion |
|-------|-----------|
| `POST /api/feeds/providers/active` with `{ providers: [] }` | HTTP 400 with `error.code: 'NO_PROVIDER_SELECTED'` |
| `POST /api/feeds/providers/active` with `{ providers: ['yahoo'] }` | `activeProviders` includes `yahoo`, does NOT include `fallback_demo` |
| `GET /api/providers/health` | `canonicalProviders[].sourceType` present; yahoo `runtimeStatus !== 'fallback_delayed'` |
| `GET /api/ml/model` | `champion` field present, `challengers` is array, `status` present |
| `GET /api/ml/model-runs` | `runs` alias present, `models` alias present |
| `GET /api/ml/model-card` | `modelCard` field present, `status` present |

---

## 8. Validation Results

All 6 modified files pass `node --check` syntax validation.

### Flows verified by smoke test assertions:

**Flow A**: `POST /api/feeds/providers/active { providers: ['yahoo'] }` → `activeProviders = ['yahoo']`, fallback_demo absent ✓  
**Flow C**: User unchecks fallback_demo (sends `{ providers: ['yahoo'] }`) → backend persists yahoo-only ✓  
**Flow D**: `POST /api/feeds/providers/active { providers: [] }` → HTTP 400 with `NO_PROVIDER_SELECTED` ✓

---

## 9. Remaining Risks / Frontend-Only Issues

These cannot be fixed from the backend repo. They require changes to `bendehibahamcherif-oss/intraday-reversal-engine`:

| Issue | File | Required Fix |
|-------|------|-------------|
| `parsedProviders` mixes activeProviders + selectedProviders + feedStatus.activeProviders | `src/workspaces/LiveDataWorkspace.jsx` | Use only `activeProviders` from backend; keep `selectedProviders` as draft-only |
| `feedStore` re-hydrates from localStorage on refresh, overriding fresh backend state | `src/store/feedStore.js` | After `loadActiveProviders` returns backend state, write it back to `activeProviders`; never let stale persist middleware override a live response |
| Yahoo `connected: false` may still display as "NOT CONNECTED" in some components | `src/components/MarketStreamStatus.jsx` | Check `sourceType === 'delayed_rest'` or `runtimeStatus === 'delayed'` → show "DELAYED" badge instead |
| mlStore reads `data.models || []` for runs but backend returns `activeJobs` | `src/store/mlStore.js` | Now resolved by adding `models` alias on backend — frontend will get correct data |
| `ProviderDiagnosticsPanel` `runtimeStatus` derivation doesn't handle `'delayed'` → display label | `src/components/ProviderDiagnosticsPanel.jsx` | Map `runtimeStatus === 'delayed'` → label `DELAYED` (green/blue badge, not error red) |
