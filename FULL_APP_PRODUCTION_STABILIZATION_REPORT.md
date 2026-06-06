# Full App Production Stabilization Report

Generated: 2026-06-06

## 1. Executive summary

This stabilization pass hardened the available `reversal` backend repository and documented the exact frontend blocker: the requested `intraday-reversal-engine` frontend repository is not present in this checkout. Backend work focused on production API contract stability, canonical backtest routes, JSON-only `/api/*` behavior, provider state response consistency, smoke coverage, and release evidence outputs.

## 2. Why previous audits missed remaining bugs

Previous checks were narrower than the production contract: they verified selected ML/historical/provider cases but did not fail the release when canonical route classes were missing, when `/api/*` could return HTML, or when the frontend repository was unavailable. The new inventory and smoke scripts make those gaps explicit instead of treating partial backend success as full-platform validation.

## 3. Full workspace inventory

See `FULL_APP_BUG_INVENTORY.md` for the workspace matrix. All frontend workspace/menu validation remains blocked in this checkout because a real frontend package is absent.

## 4. Full API contract inventory

See `FULL_APP_BUG_INVENTORY.md` for the API matrix. Backend canonical routes now include expanded smoke coverage for ML, historical, backtesting, macro, providers, feeds, portfolio, risk, and unknown API JSON handling.

## 5. Duplicated/stale components found

No frontend component source was available to inspect for duplicated AI/ML/mobile components. The only `frontend/` directory in this repository contains a single backend-side test helper (`frontend/mlTrainingState.js`) and no `package.json`, route registry, or app components.

## 6. Stale endpoints removed

No frontend source was available to remove stale `/api/ai/*` or `/api/ml/champion` calls. The new frontend smoke script will fail on those endpoint patterns if the actual frontend repo is supplied via `FRONTEND_REPO` or placed in a sibling `intraday-reversal-engine` directory.

## 7. Dataset flow fixes

Backend dataset consumers already validated missing/unknown/file-missing dataset states. The expanded smoke covers historical use-for routes and backtest/macro dataset error contracts. Frontend shared persisted dataset store work remains blocked by the absent frontend repo.

## 8. ML lifecycle fixes

Backend canonical ML endpoints are mounted and smoke-covered: dependencies, health, champion model, model runs, predictions, feature importance, drift, model card, training, promotion, and inference. Inference continues to return precise structured statuses such as no champion or feature-vector-required instead of fabricating predictions.

## 9. Python training fixes

The Python CLI exposes the expected training interface. Python test execution remains environment-blocked because the container cannot install required ML packages from PyPI (proxy tunnel returns 403) and currently lacks `numpy` and `joblib`.

## 10. Backtesting fixes

Added canonical `GET /api/backtest/runs` without requiring a symbol, made `GET /api/backtest/runs/:symbolOrRunId` compatible with both run detail and legacy symbol-scoped lists, and kept JSON-safe responses. The backtest HTML export endpoint now returns JSON containing report metadata/content instead of returning an HTML `/api/*` response.

## 11. Macro/Beta fixes

Backend macro routes already return `null` and `not_enough_data` for invalid beta/correlation rather than `NaN`; these routes are now included in full backend smoke coverage. Frontend rendering of `—` for invalid beta remains blocked by the absent frontend repo.

## 12. Provider fixes

Provider credential/active/health responses now include a canonical `ok` field alongside existing `success` fields so provider panels and smokes can consume a consistent backend truth contract.

## 13. Portfolio/Risk fixes

Portfolio and risk safe-state routes are covered in the expanded backend smoke. No frontend rendering changes were possible in this checkout.

## 14. Mobile navigation fixes

Blocked: no frontend workspace registry/mobile navigation source is present. The frontend smoke records this as `frontend_repo_unavailable` and will scan a supplied frontend repo for stale endpoint classes and workspace registry presence.

## 15. localStorage/Zustand fixes

Blocked: no frontend stores are present. Backend provider state remains the source of truth and existing provider tests cover fallback_demo persistence behavior.

## 16. Error boundary fixes

Blocked: no frontend components are present. Backend `/api/*` unknown/error responses are JSON-only and sanitized.

## 17. WebSocket fixes

Blocked for frontend retry UI. Backend Socket.IO server still starts; REST smoke confirms REST endpoints remain usable even when Yahoo live requests fail and fallback state is reported by backend.

## 18. Backend tests added

Added `server/tests/apiContractRoutes.test.js` covering canonical backtest run listing, unknown `/api` JSON 404 shape, and JSON sanitizer behavior for NaN/Infinity/BigInt/Date/circular values.

## 19. Frontend tests added

Added `scripts/full-frontend-smoke.js`. In this checkout it writes an unavailable result because no frontend package exists; against a real frontend repo it scans source files for stale ML endpoints, undefined dataset/symbol path params, unsafe non-finite rendering risk, and workspace registry presence.

## 20. Smoke results

- `FULL_BACKEND_SMOKE_RESULTS.json`: passed 47/47 checks.
- `FULL_FRONTEND_SMOKE_RESULTS.json`: command passed with `status=frontend_repo_unavailable` and `frontendRepoAvailable=false`.
- `FULL_PLATFORM_CONTRACT_SMOKE_RESULTS.json`: command passed because backend smoke passed and frontend unavailability was explicitly recorded rather than hidden.

## 21. Build results

- `npm test`: passed 79/79 Node tests.
- `npm run build`: passed syntax checks.
- `node scripts/full-backend-smoke.js`: passed 47/47 backend contract checks.
- `node scripts/full-frontend-smoke.js`: passed with explicit frontend repository unavailable evidence.
- `node scripts/full-platform-contract-smoke.js`: passed combined backend/frontend evidence aggregation.
- `python3 server/ai/train_pipeline.py --help`: passed.
- `python3 -m pytest server/ai/tests -v`: blocked by missing `numpy` and `joblib`.
- `python3 -m pip install -r requirements-ml.txt`: blocked by network/proxy `403 Forbidden` to package index.
- `npm run frontend:build`, `npm run lint`, `npm run typecheck`: unavailable scripts in backend `package.json`.

## 22. Remaining risks

1. Frontend repo absent: mobile menu, duplicated ML components, localStorage/Zustand hydration, error boundaries, WebSocket retry UI, and rendered NaN cannot be source-fixed here.
2. Python ML dependency install blocked by network/proxy, so Python pytest cannot complete in this container.
3. External live data credentials are not available, so provider connectivity beyond backend contract/state cannot be production-verified.

## 23. Manual checks

Manual browser/mobile checks were not possible because no runnable frontend app exists in this checkout. Backend route-level checks were automated through full backend smoke.

## 24. Deployment notes

The backend root/version endpoints identify the service and version. Production frontend API base, deployed frontend bundle strings, Render ML dependency installation, and real user mobile flows require access to the missing frontend repo/deployment environment.
