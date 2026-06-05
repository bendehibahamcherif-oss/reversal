# Platform Stabilization Report

Generated: 2026-06-05
Repository available in workspace: `reversal` backend only. The sibling frontend repository `intraday-reversal-engine` was not present under `/workspace`, so frontend code edits, frontend API-client hardening, Zustand/localStorage migrations, frontend screenshots, and frontend smoke tests could not be completed in this checkout. Backend contracts were stabilized so the frontend has mounted, structured endpoints for the required ML, provider, feed, portfolio, and risk panels.

## 1. Executive summary

- Added/verified backend contract coverage for required ML empty states, provider health, live feed status, portfolio safe states, and risk safe states.
- Created `PLATFORM_FUNCTIONAL_MATRIX.md` and `API_CONTRACT_MATRIX.md` to make workspace dependencies and route contracts explicit.
- Added `scripts/platform-smoke.js`, which starts the backend, validates required endpoint status/schema, and writes `PLATFORM_SMOKE_RESULTS.json`.
- Added backend tests for ML, provider consistency, portfolio/risk safe routes, mounted feed routes, and mounted canonical provider diagnostics.
- Confirmed the new platform smoke test is green: 22/22 endpoints passed, no required endpoint returned 404.

## 2. Functional matrix summary

- ML, Providers, Credentials, Stream Status, Live Data, Portfolio, and Risk have explicit backend route coverage and tests.
- Workspaces whose frontend source is unavailable are marked in the matrix with mounted backend status and any remaining frontend verification need.
- Placeholder panels are marked `not_implemented_but_safe` where they should not call dead endpoints.

## 3. Endpoints fixed

- `GET /api/ml/health` now exposes the required `status: "available"` and `worker` availability contract.
- `GET /api/providers/health` now returns canonical provider objects, `activeProviders`, `providerOrder`, and stream diagnostics when the market stream diagnostics route is mounted first.
- `GET /api/portfolio/history` was added with a structured empty history response.
- `GET /api/risk/summary` now reports empty state as `risk.status: "not_enough_data"`.

## 4. Backend routes added/mounted

- Added `GET /api/portfolio/history` under the existing `/api/portfolio` mount.
- Hardened the already mounted market-stream `/api/providers/health` route so it does not shadow canonical provider state with stream-only diagnostics.
- Confirmed required ML, provider, feed, portfolio, and risk routes are mounted in runtime integration.

## 5. Frontend API paths fixed

- Frontend repository was not present in this workspace; no frontend files could be modified.
- Backend now supports both `/api/feed/status` and `/api/feeds/*` aliases required by the requested contract.
- Remaining frontend action: apply `API_CONTRACT_MATRIX.md` against `intraday-reversal-engine` when that repository is available, especially central API response handling and Zustand/localStorage cache rules.

## 6. ML workspace fixes

- ML health now remains route-available even if the Python worker/champion model is not configured.
- Existing empty-state ML endpoints were verified and covered by tests: model, model-runs, predictions, feature-importance, drift, model-card, and infer no-champion state.
- No raw ML 404 remains for the required endpoints in the backend smoke test.

## 7. Provider credential fixes

- Provider tests verify Alpha Vantage save/delete, masked credentials, environment-key recognition, canonical provider health, and rejection of selecting credentialed providers without credentials.
- The mounted `/api/providers/health` response now includes canonical provider objects with credential/runtime fields even when stream diagnostics are mounted first.

## 8. `fallback_demo` persistence fixes

- Tests verify explicit `providers: ["yahoo"]` persists without re-adding `fallback_demo`.
- Tests verify stale `enabledByProvider.fallback_demo=true` cannot override an explicit saved provider list.
- Tests verify `providers: ["yahoo", "alphaVantage"]` preserves order and keeps `fallback_demo` inactive.

## 9. Live data status fixes

- Yahoo delayed-source semantics are covered by tests: active Yahoo can have `connected=false` while `runtimeStatus="delayed"` and `sourceType="delayed"`.
- `fallback_demo` warnings are not shown as active unless the backend active provider list includes `fallback_demo`.

## 10. Portfolio/Risk fixes

- Portfolio required routes are mounted and tested: summary, positions, pnl, exposure, drawdown, history.
- Risk required routes are mounted and tested: summary, limits, var, drawdown, exposure, alerts.
- Empty portfolio/risk states now return JSON 200 safe contracts rather than raw HTTP 404.

## 11. WebSocket status handling

- Backend Socket.IO server remains available on the app origin and is not required for REST platform smoke success.
- Frontend WS status model changes could not be implemented because the frontend repository is absent.
- Remaining frontend action: represent unavailable Socket.IO as `UNAVAILABLE`/`DEGRADED` while continuing REST polling.

## 12. Error boundary/localStorage fixes

- Frontend error-boundary and localStorage/Zustand changes could not be implemented because the frontend repository is absent.
- Backend provider selection is the canonical source for active providers; tests cover stale persisted fallback flags not overriding explicit provider selections.

## 13. Tests added

- Added `server/tests/platformSafeRoutes.test.js` for required ML, feed, portfolio, and risk safe-route coverage.
- Extended `server/tests/mlRoutes.test.js` with ML health, predictions, feature importance, and model-card empty-state assertions.
- Extended `server/tests/providerState.test.js` to cover canonical provider health under the real mounted route ordering.

## 14. Smoke test result

- `node scripts/platform-smoke.js` passed 22/22 endpoint checks.
- `PLATFORM_SMOKE_RESULTS.json` records `ok: true`, `passed: 22`, `failed: 0`.
- Yahoo external REST fetches failed in this environment, but required smoke endpoints still returned JSON 200 and no 404. This is documented as an external network/provider limitation, not an API-contract failure.

## 15. Build/test result

- `npm test`: passed 24/24 backend tests.
- `npm run build`: passed Node syntax checks.
- `node scripts/platform-smoke.js`: passed 22/22 smoke checks and wrote `PLATFORM_SMOKE_RESULTS.json`.
- `npm run server:smoke`: attempted but aborted because the legacy smoke script repeatedly waited on failing Yahoo external requests; the new focused platform smoke is green.
- `npm run lint`, `npm run typecheck`, and `npm run frontend:build`: scripts are not defined in this backend `package.json`.

## 16. Remaining risks

- Frontend repository is absent; frontend API paths, API-client standardization, UI empty states, error boundaries, localStorage migrations, and frontend tests remain to be applied in `intraday-reversal-engine`.
- External Yahoo requests failed from this environment; delayed Yahoo semantics are represented correctly, but real market-data delivery depends on outbound provider availability.
- Legacy `scripts/server-smoke.cjs` is broad and slow when Yahoo is unavailable; `scripts/platform-smoke.js` is the new required contract smoke for the stabilization matrix.

## 17. Exact manual checks still needed

1. In the frontend repo, verify ML Dashboard, Model Registry, Diagnostics & Drift, and Champion Inference render the backend empty states without "Endpoint not available".
2. Save Alpha Vantage credentials in the UI and confirm Credentials, Providers, and Diagnostics agree.
3. Save `yahoo` only with `fallback_demo` unchecked, refresh, and confirm `fallback_demo` remains inactive.
4. Open Portfolio and Risk panels and confirm empty states render without raw HTTP 404.
5. Disconnect/withhold WebSocket backend and confirm frontend displays a diagnosed WS status while REST panels continue to load.
