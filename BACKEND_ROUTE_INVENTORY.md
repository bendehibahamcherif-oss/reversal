# Backend Route Inventory

**Repo:** `reversal` · **Date:** 2026-06-06
**Mount source:** `server/bootstrap/runtimeIntegration.js` (35 routers) + `server.js` (root, version, 404, error middleware)

All `/api/*` routes return JSON. Unknown `/api/*` → `404 { ok:false, status:"endpoint_not_found" }`. Uncaught errors → `500 { ok:false, status:"internal_error", requestId }` (global middleware, `server.js`).

## ML — `/api/ml` (`server/api/mlRoutes.js`)

| Route | Method | Response / status | Status |
|---|---|---|---|
| `/dependencies` | GET | `ok, status(ready\|ready_with_optional_missing\|python_dependency_missing\|python_unavailable), python{available,version,bin}, dependencies{}, requiredMissing[], optionalMissing[]` | ✅ enhanced |
| `/health` | GET | `ok, status:"available", worker{}` | ✅ |
| `/model` | GET | `ok, champion(null\|obj), challengers[], status` | ✅ |
| `/model-runs`, `/training-runs` | GET | `ok, runs[]` (no symbol required) | ✅ |
| `/predictions` | GET | `ok, predictions[]` | ✅ |
| `/feature-importance` | GET | `ok, features[]` | ✅ |
| `/drift` | GET | `ok, drift{}` | ✅ |
| `/model-card` | GET | `ok, modelCard, status` | ✅ |
| `/schema`, `/metrics`, `/worker/status`, `/signal/:symbol` | GET | safe JSON empty states | ✅ |
| `/train` | POST | `trained` / precise dataset & dependency errors | ✅ |
| `/promote/:modelId` | POST | promotes candidate, demotes prior champion | ✅ |
| `/infer/:symbol` | POST | `no_champion_model` / `feature_vector_required` / prediction — never 404 | ✅ |

## Historical — `/api/historical` (`server/api/historicalRoutes.js`)

| Route | Method | Status |
|---|---|---|
| `/providers`, `/status` | GET | ✅ |
| `/datasets` | GET | ✅ live `fileExists`/`csvFileExists`/`status` |
| `/datasets/:id` | GET | ✅ `dataset_not_found` 404 |
| `/datasets/:id/diagnostics` | GET | ✅ registry+file+rows |
| `/datasets/:id/candles` | GET | ✅ |
| `/download` | POST | ✅ `symbols[]` + legacy `symbol`, `symbol_required` only when empty |
| `/use-for-ml` | POST | ✅ **NEW** — `ready` / `dataset_required` / `dataset_not_found` / `dataset_file_missing` / `dataset_file_empty` / `dataset_csv_missing` |
| `/use-for-backtest` | POST | ✅ **NEW** (JSON candles accepted) |
| `/use-for-correlation` | POST | ✅ **NEW** (JSON candles accepted) |
| `/datasets/:id` | DELETE | ✅ |

## Providers / Feed — `/api/providers`, `/api/feed(s)`, `/api/market`

| Route | Method | Status |
|---|---|---|
| `/providers/health`, `/active`, `/credentials`, `/status`, `/runtime`, `/debug-state` | GET | ✅ |
| `/providers/active`, `/credentials`, `/credentials/:id` | POST | ✅ |
| `/providers/credentials/:id` | DELETE | ✅ |
| `/feed/status`, `/feeds/tick|candle|orderbook/:symbol` | GET | ✅ |

## Backtest — `/api/backtest` (`backtestRoutes.js`)
`POST /run` accepts `datasetId` → `dataSource.type:"historical_dataset"`; errors `dataset_not_found`/`dataset_file_missing`/`not_enough_data`. ✅ (covered by `historicalDatasetConsumers.test.js`)

## Macro / Multi-Asset — `/api/macro`, `/api/multi-asset`
`/correlation`, `/beta`, `/sector-rotation`, `/volatility-heatmap` — accept `datasetId`; beta/correlation return `null` (never NaN) + `status:not_enough_data`; all `sanitizeJson`-wrapped. ✅

## Portfolio / Risk — `/api/portfolio`, `/api/risk`
`summary, positions, pnl, exposure, drawdown, history` / `summary, limits, var, drawdown, exposure, alerts` — safe JSON empty states. ✅

## Platform
`/api/version` (GET) ✅ NEW (#99) · `/api/alerts` CRUD ✅ · `/api/observability/*`, `/api/chart/*`, `/api/volume-profile/:symbol`, `/api/strategy-lab/*`, `/api/quant/*`, `/api/replay*`, `/api/paper/*` — mounted ✅

## Helpers
`server/utils/apiResponse.js` — **NEW** `sendOk` / `sendError` / `sanitizeJson` (NaN/Infinity→null, undefined dropped, Date→ISO, Error→safe, BigInt→string, cycle-safe).
