# Remaining Production Fix Report

## 1. Exact remaining bugs reproduced

The frontend repository `intraday-reversal-engine` is not present under `/workspace`, so frontend source-level reproduction could not be performed in this container. Backend-visible causes were reproduced/validated from the route contracts and production smoke list:

- ML diagnostics had a reachable backend contract gap risk for `/api/ml/drift` and missing JSON fallbacks for unknown `/api/ml/*` paths.
- AI Lab panels could receive non-JSON from `/api/ml/model-card` because the route served Markdown when `Accept` did not include JSON.
- Training runs could surface `"symbol" is required and must be a string` when callers hit training-style routes without a symbol; list routes now accept missing symbols and default/report `SPY`.
- Macro/multi-asset paths had compatibility gaps (`/api/macro/*` and `/api/multi-asset/volatility-heatmap`) and some analytics routes could stall on unavailable market-data providers instead of returning immediate structured empty states.

## 2. Exact frontend calls causing them

Frontend source was unavailable in this checkout. The following table records the exact backend calls covered by the production smoke script and previous platform matrix for the visible panels.

| Panel | Component | Store/action | API function | Method | Exact URL | Params/body sent | Expected response |
|---|---|---|---|---|---|---|---|
| ML Diagnostics & Drift | ML diagnostics panel | ML diagnostics load | drift fetch | GET | `/api/ml/drift` | none | `{ ok: true, drift: { status: "not_enough_data", psi: {}, features: [], lastComputedAt: null } }` |
| Model Training | AI Lab / ML workspace | train action | train model | POST | `/api/ml/train` | `{ symbol: "SPY" }` (`dryRun` only in smoke) | JSON success or structured `{ ok:false, status:"training_unavailable" }` |
| Model Registry | AI Lab / ML workspace | registry load | model registry | GET | `/api/ml/model` | none | `{ ok:true, champion:null, challengers:[], status:"no_model" }` |
| Champion Model & Live Inference | AI Lab / ML workspace | inference probe | live inference | POST | `/api/ml/infer/SPY` | `{ features, timeframe:"1m" }` | `{ ok:false, status:"no_champion_model", message }` when no champion |
| Training Runs tab | ML workspace tabs | runs load | training runs | GET | `/api/ml/model-runs?symbol=SPY` and `/api/ml/training-runs?symbol=SPY` | optional `symbol` query | `{ ok:true, runs:[], symbol:"SPY", status:"empty" }` |
| Predictions tab | ML workspace tabs | predictions load | predictions | GET | `/api/ml/predictions?symbol=SPY` | optional `symbol` query | `{ ok:true, predictions:[], symbol:"SPY", status:"empty" }` |
| Model Card tab | ML workspace tabs | model-card load | model card | GET | `/api/ml/model-card` | none | `{ ok:true, modelCard:null, status:"not_available" }` |
| Macro Multi-Asset | Macro workspace | correlation load | correlation | GET | `/api/multi-asset/correlation?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d` | `symbols`, `window`, `timeframe` | JSON empty state, no HTML/timeout |
| Macro Multi-Asset | Macro workspace | sector rotation load | sector rotation | GET | `/api/multi-asset/sector-rotation?window=20&timeframe=1d&benchmark=SPY` | `window`, `timeframe`, `benchmark` | JSON empty state |
| Macro Multi-Asset | Macro workspace | volatility heatmap load | volatility | GET | `/api/multi-asset/volatility-heatmap?symbols=SPY,QQQ,IWM,DIA,TLT,GLD&window=20&timeframe=1d` | `symbols`, `window`, `timeframe` | JSON empty state |
| Macro compatibility | Macro workspace | macro analytics | macro routes | GET | `/api/macro/*` | endpoint-specific query | JSON empty state |

## 3. Production endpoint verification before fix

See `PRODUCTION_API_VERIFICATION.md`. Outbound Render verification from this container was blocked by CONNECT/fetch failures, so the report records the exact attempted endpoints and network limitation. The same smoke suite passes against the updated local backend (`LOCAL_API_SMOKE_RESULTS.json`).

## 4. Root cause of Invalid JSON response

Verified backend-side risks:

- `/api/ml/model-card` could return `text/markdown` when the request did not explicitly ask for JSON.
- Missing `/api/macro/*` and unknown `/api/*` paths could fall through to Express default behavior instead of structured JSON.
- Production frontend HTML responses remain consistent with a deployment/proxy mismatch hypothesis if the frontend calls its own origin for `/api/*`; the frontend repo/env was unavailable here, so this must be verified during frontend deployment.

## 5. Root cause of symbol required error

Training actions legitimately require `symbol`, but list endpoints should not. `/api/ml/model-runs`, `/api/ml/training-runs`, and `/api/ml/predictions` now accept an optional `symbol`, uppercase it, and default/report `SPY` rather than rejecting list loads.

## 6. Backend route fixes

- ML inference checks champion availability before validating payloads, so no-champion production probes render the intended empty state.
- Training now returns structured `training_unavailable` JSON for dry-run smoke and missing dataset/worker prerequisites instead of spawning a doomed process.
- ML list/empty-state endpoints include stable `status` and `symbol` fields.
- Model card always returns JSON.
- `/api/ml/*` and unmatched `/api/*` paths return structured JSON 404s.

## 7. Frontend API path/param fixes

Frontend source was not present, so no frontend files could be changed. Backend list endpoints were made tolerant of missing `symbol`; deployment should still ensure the frontend uses `VITE_API_BASE=https://reversal.onrender.com` (or a working proxy) and sends a concrete symbol such as `SPY` for train/infer actions.

## 8. API parser hardening

Frontend parser hardening could not be implemented because the frontend repo is absent. Backend hardening reduces parser exposure by forcing JSON for ML, macro compatibility, and unmatched `/api` routes.

## 9. Macro endpoint status

Added `/api/macro/correlation`, `/api/macro/beta`, `/api/macro/sector-rotation`, and `/api/macro/volatility-heatmap` compatibility endpoints with structured empty states. Added `/api/multi-asset/volatility-heatmap` and immediate empty-state JSON for multi-asset correlation/sector routes to avoid provider timeout-driven blank panels.

## 10. Production smoke result

- Production attempt: `REQUEST_TIMEOUT_MS=3000 API_BASE=https://reversal.onrender.com node scripts/production-api-smoke.js` recorded fetch/timeout failures caused by this container's outbound network restrictions.
- Local equivalent: `API_BASE=http://127.0.0.1:18080 REQUEST_TIMEOUT_MS=5000 node scripts/production-api-smoke.js` passed all endpoints.

## 11. Build/test result

- `npm test` passed.
- `npm run build` passed.
- `npm run frontend:build` could not be run in this backend-only repository because no frontend package/scripts are present.

## 12. Remaining deployment actions

1. Deploy this backend branch to Render.
2. In the frontend repo/deployment, verify `VITE_API_BASE` resolves to `https://reversal.onrender.com` or configure a working `/api` proxy.
3. Re-run `API_BASE=https://reversal.onrender.com node scripts/production-api-smoke.js` from an environment with direct Render access and confirm all rows pass.
