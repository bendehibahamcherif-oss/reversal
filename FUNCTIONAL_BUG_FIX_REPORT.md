# Functional Bug Fix Report — ML Endpoints and Provider Persistence

## 1. Root Causes

- **ML empty states were not fully contractual.** Core ML routes were mounted, but `POST /api/ml/infer/:symbol` returned a legacy `NO_CHAMPION`/422 error when no model metadata existed. Some frontend clients interpret that as endpoint failure instead of the valid no-model state.
- **Drift payload shape was inconsistent with the expected frontend contract.** `/api/ml/drift` returned an empty state, but used `detectedAt` rather than the expected `lastComputedAt` field.
- **Provider restore logic trusted stale `enabledByProvider` flags over the explicit saved `providers` list.** Older persisted payloads such as `providers: ["yahoo"]` plus `enabledByProvider.fallback_demo = true` could silently reactivate `fallback_demo`.
- **Provider order was not always the saved order.** The resolver prepended a hard-coded preferred order, which could reorder user-saved provider selections.
- **Yahoo delayed REST activity was represented as connected live status in activity promotion.** That made the UI see a contradiction between delayed Yahoo data being available and Yahoo appearing as a connection failure/not-connected source.
- **Fallback demo warnings leaked when the provider was inactive.** Canonical provider health could include demo warnings even when `fallback_demo` was not active.

## 2. Route Registration Audit

| Route | Mounted by | Status |
|---|---|---|
| `GET /api/ml/health` | `app.use('/api/ml', mlRoutes)` | Present |
| `GET /api/ml/model` | `app.use('/api/ml', mlRoutes)` | Present; returns `no_model` when metadata is absent |
| `GET /api/ml/model-runs` | `app.use('/api/ml', mlRoutes)` | Present; alias of training runs |
| `GET /api/ml/predictions` | `app.use('/api/ml', mlRoutes)` | Present; returns empty predictions |
| `GET /api/ml/feature-importance` | `app.use('/api/ml', mlRoutes)` | Present; returns empty features without champion |
| `GET /api/ml/drift` | `app.use('/api/ml', mlRoutes)` | Present; now returns expected structured drift empty state |
| `GET /api/ml/model-card` | `app.use('/api/ml', mlRoutes)` | Present; returns `not_available` when card is absent |
| `POST /api/ml/infer/:symbol` | `app.use('/api/ml', mlRoutes)` | Present; now returns `no_champion_model` state without 404/endpoint failure |
| `POST /api/ml/train` | `app.use('/api/ml', mlRoutes)` | Present |
| `GET /api/providers/health` | `app.use('/api/providers', providerCredentialRoutes)` | Present |
| `GET /api/providers/credentials` | `app.use('/api/providers', providerCredentialRoutes)` | Present |
| `POST /api/providers/credentials/:providerId` | `app.use('/api/providers', providerCredentialRoutes)` | Present |
| `DELETE /api/providers/credentials/:providerId` | `app.use('/api/providers', providerCredentialRoutes)` | Present |
| `GET /api/providers/active` | `app.use('/api/providers', providerCredentialRoutes)` | Present |
| `POST /api/providers/active` | `app.use('/api/providers', providerCredentialRoutes)` | Present |
| `GET /api/feed/status` | `app.use('/api/feed', feedRoutes)` | Present |
| `GET /api/feeds/status` | `app.use('/api/feeds', feedRoutes)` | Present, compatible alias to same router |
| `GET /api/feeds/tick/:symbol` | `app.use('/api/feeds', feedRoutes)` | Present |
| `GET /api/feeds/candle/:symbol` | `app.use('/api/feeds', feedRoutes)` | Present |
| `GET /api/feeds/orderbook/:symbol` | `app.use('/api/feeds', feedRoutes)` | Present |

## 3. ML Endpoint Fixes

| Component | Endpoint called | Backend route exists? | Current response before fix | Fix |
|---|---|---:|---|---|
| ML Diagnostics & Drift | `GET /api/ml/drift` | Yes | Structured empty response, but timestamp field did not match expected contract | Returned `drift.status = not_enough_data`, `psi = {}`, `features = []`, and `lastComputedAt = null` |
| Model Registry | `GET /api/ml/model-runs` | Yes | Empty runs were already returned when no active training jobs existed | Added route-level regression coverage to prevent future 404/contract regressions |
| Champion Model | `GET /api/ml/model` | Yes | Empty champion state already returned as `status: no_model` | Added regression coverage to ensure no-model is not treated as endpoint unavailable |
| Live Inference | `POST /api/ml/infer/:symbol` | Yes | Missing champion returned legacy 422/`NO_CHAMPION` error | Returns valid no-champion state: `ok: false`, `status: no_champion_model`, and a clear message |
| Predictions | `GET /api/ml/predictions` | Yes | Empty predictions array already returned | Verified as part of route audit |
| Feature Importance | `GET /api/ml/feature-importance` | Yes | Empty features already returned without champion | Verified as part of route audit |
| Model Card | `GET /api/ml/model-card` | Yes | Empty not-available state already returned | Verified as part of route audit |

## 4. Provider Selection Fixes

- The backend now treats the explicit `providers` list as the saved source of truth when resolving persisted provider state.
- Stale `enabledByProvider` entries cannot re-add providers that are absent from the explicit saved `providers` list.
- Provider order now follows the saved/deduped request order rather than a hard-coded preferred order.
- Empty provider selection now returns a structured 400 validation error with code `NO_PROVIDER_SELECTED` and message `Select at least one provider.`

## 5. `fallback_demo` Persistence Fix

- `fallback_demo` is not silently re-added when at least one viable explicitly selected provider remains.
- A stale persisted `enabledByProvider.fallback_demo = true` flag is ignored when `providers` explicitly omits `fallback_demo`.
- `fallback_demo` warnings only appear in canonical provider status when `fallback_demo` is active.

## 6. Live Data Status Consistency Fix

- Yahoo delayed REST activity now remains canonical delayed data rather than being promoted to websocket-like connected status.
- Canonical Yahoo status reports:
  - `runtimeStatus: delayed`
  - `sourceType: delayed`
  - `connected: false`
  - `credentialStatus: not_required`
  - warning: `Yahoo is delayed data, not live institutional feed.`
- Demo provider status reports demo warnings only when active.
- `/api/feed/status` and `/api/providers/health` share the same canonical active provider state.

## 7. Files Changed

- `server/api/mlRoutes.js`
- `server/feeds/feedManager.js`
- `server/tests/mlRoutes.test.js`
- `server/tests/providerState.test.js`
- `FUNCTIONAL_BUG_FIX_REPORT.md`

## 8. Tests Added

Backend tests added/updated:

1. `GET /api/ml/drift` returns 200 with structured empty state.
2. `GET /api/ml/model-runs` returns 200 with `runs: []`.
3. `GET /api/ml/model` returns 200 with `champion: null` and `status: no_model`.
4. `POST /api/ml/infer/:symbol` returns no champion model state when no champion exists.
5. `POST /api/providers/active` with Yahoo only does not re-add `fallback_demo`.
6. `POST /api/providers/active` with Yahoo + Alpha Vantage persists order when Alpha Vantage credentials are configured.
7. `GET /api/feed/status` matches `/api/providers/health` active provider state.
8. Empty provider selection returns structured `NO_PROVIDER_SELECTED` validation error.
9. Stale `fallback_demo` enabled flags cannot override an explicit Yahoo-only saved selection.
10. Yahoo delayed source reports `runtimeStatus: delayed` instead of a connection failure.

Frontend tests were not added because the `intraday-reversal-engine` frontend repository is not present in this workspace. The current checkout is the backend `reversal` repository only.

## 9. Validation Results

- `npm test` passed.
- `npm run build` passed.
- `npm run frontend:build` is not available in this backend package.
- `npm run lint` is not available in this backend package.
- `npm run typecheck` is not available in this backend package.
- `npm run server:smoke` was started and exercised many routes successfully, but was stopped after repeated Yahoo Finance outbound fetch failures caused long retry/fallback delays in this environment.

## 10. Remaining Risks

- Frontend store behavior and component rendering could not be changed or tested because the frontend repository is not present in `/workspace`.
- Yahoo Finance availability depends on outbound network access and can still be slow or unavailable in restricted environments; backend status now reports it as delayed REST data rather than a broken live connection when it delivers data.
- Existing `/api/feed` and `/api/feeds` prefixes remain as compatible aliases to the same router to support both frontend call variants without incompatible route behavior.
