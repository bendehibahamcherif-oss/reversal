# HISTORICAL DATA DOWNLOAD CENTER — IMPLEMENTATION REPORT

## Summary

A complete historical market data ingestion pipeline has been implemented:
- **Backend** (pushed to `claude/feed-chart-routes-format-f6bKw`): provider adapters, dataset registry, REST API, and integrations with ML training, backtesting, and correlation analytics.
- **Frontend** (committed locally in `/home/user/intraday-reversal-engine`, push blocked by proxy restriction to `bendehibahamcherif-oss/reversal` only): workspace, Zustand store, API methods, sidebar nav entry.

---

## Architecture

### Backend modules created

| File | Purpose |
|---|---|
| `server/historical/candleSchema.js` | Canonical OHLCV candle validation + normalizer |
| `server/historical/providerCapabilities.js` | Provider capability matrix (timeframes, lookback, rate limits, credential requirements) |
| `server/historical/historicalDatasetRegistry.js` | JSON-backed dataset registry (CRUD, filter by symbol/timeframe/provider/purpose) |
| `server/historical/providers/yahooHistoricalProvider.js` | Yahoo Finance v8 chart API with period1/period2 date-range parameters |
| `server/historical/providers/twelveDataHistoricalProvider.js` | Twelve Data time_series with start_date/end_date |
| `server/historical/providers/polygonHistoricalProvider.js` | Polygon /v2/aggs with cursor-based pagination |
| `server/historical/providers/alphaVantageHistoricalProvider.js` | Alpha Vantage intraday + daily adjusted endpoints |
| `server/historical/historicalDataService.js` | Main orchestrator: dispatch download, serialize to JSON, register dataset |
| `server/api/historicalRoutes.js` | Express routes under `/api/historical` |
| `server/data/historical/datasets.json` | Empty registry seed file |
| `server/data/historical/raw/` | Storage for general/raw downloads |
| `server/data/historical/ml/` | Storage for ML-purpose downloads |
| `server/data/historical/backtest/` | Storage for backtest-purpose downloads |
| `server/data/historical/correlation/` | Storage for correlation-purpose downloads |

### Backend files modified

| File | Change |
|---|---|
| `server/bootstrap/runtimeIntegration.js` | Added `import historicalRoutes` and `app.use('/api/historical', historicalRoutes)` |
| `server/api/mlRoutes.js` | `POST /train` now accepts `datasetId` and `datasetPath`; resolves dataset file path and passes `--data <filePath>` to `train_pipeline.py` |
| `server/api/backtestRoutes.js` | `POST /run/:symbol` accepts `datasetId`, loads candles async and passes to `backtestEngine.runBacktest()` |
| `server/api/multiAssetRoutes.js` | `GET /correlation` accepts `datasetId`, resolves dataset record and attaches `dataSource` to response |
| `scripts/server-smoke.cjs` | Added smoke entries and validators for `/api/historical/status`, `/api/historical/providers`, `/api/historical/datasets` |

---

## API Endpoints

### `GET /api/historical/status`
Returns service health, dataset count, and provider summary.

```json
{"ok":true,"service":"historical-data","datasetCount":0,"providers":[...]}
```

### `GET /api/historical/providers`
Returns full provider capability matrix for all 4 providers.

```json
{"ok":true,"providers":[
  {"id":"yahoo","name":"Yahoo Finance","requiresCredentials":false,"timeframes":["1m","5m","15m","30m","1h","4h","1d","1w"],...},
  {"id":"twelvedata",...},
  {"id":"polygon",...},
  {"id":"alphaVantage",...}
]}
```

### `POST /api/historical/download`
Triggers a download and stores results.

**Body:**
```json
{
  "symbol": "AAPL",
  "timeframe": "1d",
  "provider": "yahoo",
  "startDate": "2023-01-01",
  "endDate": "2024-01-01",
  "purpose": "ml"
}
```

**Response:**
```json
{
  "ok": true,
  "dataset": {
    "id": "uuid",
    "symbol": "AAPL",
    "timeframe": "1d",
    "provider": "yahoo",
    "startDate": "2023-01-03",
    "endDate": "2023-12-29",
    "candleCount": 250,
    "filePath": "server/data/historical/ml/AAPL_1d_yahoo_1234567890.json",
    "fileSize": 87234,
    "purpose": "ml",
    "sourceType": "delayed_rest",
    "warnings": [],
    "createdAt": 1234567890000,
    "status": "ready"
  },
  "candleCount": 250,
  "skipped": 0,
  "warnings": []
}
```

### `GET /api/historical/datasets`
Lists stored datasets. Query: `symbol`, `timeframe`, `provider`, `purpose`.

### `GET /api/historical/datasets/:id`
Get a single dataset record.

### `GET /api/historical/datasets/:id/candles`
Stream candles from a stored dataset. Query: `limit`, `offset`.

### `DELETE /api/historical/datasets/:id`
Delete dataset record and backing file.

---

## Provider Capabilities

| Provider | Requires Key | Intraday Lookback | Daily Lookback | Rate |
|---|---|---|---|---|
| Yahoo Finance | No | 7d (1m), 60d (5m–30m), 2y (1h) | 20y | 20 req/min |
| Twelve Data | Yes | 365d | Unlimited | 8 req/min |
| Polygon.io | Yes | 2y (1m), 5y (15m+) | Unlimited | 5 req/min |
| Alpha Vantage | Yes | 30d (intraday) | Unlimited | 5 req/min (25/day free) |

---

## Candle Schema

All providers normalize to:
```json
{
  "timestamp": 1704067200000,
  "symbol": "AAPL",
  "timeframe": "1d",
  "open": 185.20,
  "high": 186.50,
  "low": 184.80,
  "close": 185.92,
  "volume": 48234000,
  "provider": "yahoo",
  "session": "regular",
  "sourceType": "delayed_rest",
  "adjusted": false
}
```

---

## ML Training Integration

`POST /api/ml/train` now accepts:
```json
{
  "symbol": "AAPL",
  "horizon": 20,
  "datasetId": "uuid-of-dataset"
}
```

When `datasetId` is provided:
1. Validates dataset exists in registry
2. Verifies file exists on disk
3. Passes `--data <filePath>` to `train_pipeline.py`

`train_pipeline.py` already accepted `--data <parquet_path>` — the JSON format needs to be supported on the Python side for full end-to-end use, but the CLI argument passing is wired correctly.

---

## Backtest Integration

`POST /api/backtest/run/:symbol` now accepts `datasetId` in the request body. When provided, the historical candles are loaded and passed to `backtestEngine.runBacktest()` as an optional 5th argument. The response includes a `dataSource` field with metadata about which dataset was used.

---

## Correlation Integration

`GET /api/multi-asset/correlation` now accepts `datasetId` query parameter. The dataset record is resolved and attached as `dataSource` in the response. (Full candle injection into the engine is a follow-up — the current `correlationMatrix()` in `multiAssetEngine.js` would need to be extended to accept pre-loaded candles.)

---

## Smoke Test Results

```
OK GET /api/historical/status        ← verifies service:'historical-data', datasetCount, providers[]
OK GET /api/historical/providers     ← verifies all 4 providers present with timeframes
OK GET /api/historical/datasets      ← verifies ok:true, datasets[], count
```

Full smoke suite: **exit 0** (all existing checks + 3 new historical checks pass).

---

## Frontend Changes (committed locally, push blocked by proxy restriction)

**Files in `intraday-reversal-engine`:**

| File | Purpose |
|---|---|
| `src/workspaces/HistoricalDataWorkspace.jsx` | Full workspace with Download, Datasets, Providers tabs |
| `src/store/historicalDataStore.js` | Zustand store (providers, datasets, download state, candle preview) |
| `src/api.js` | +7 historical API methods |
| `src/App.jsx` | Added `case 'HistoricalData': return <HistoricalDataWorkspace />` |
| `src/TerminalSidebar.jsx` | Added `{ id: 'HistoricalData', abbr: 'HD', title: 'Historical Data' }` |

The frontend code is committed locally at `/home/user/intraday-reversal-engine` on the `main` branch but could not be pushed to the remote because the session proxy is restricted to `bendehibahamcherif-oss/reversal`.

---

## Data Flow

```
User: POST /api/historical/download { symbol, timeframe, provider, startDate, endDate, purpose }
  → historicalRoutes.js validates input
  → historicalDataService.downloadHistoricalDataset()
    → provider adapter.download() (Yahoo/TwelveData/Polygon/AlphaVantage)
      → Real HTTP request to provider API
      → normalizeCandleBatch() → canonical candle array
    → writeFileSync(filePath, JSON.stringify(payload))
    → historicalDatasetRegistry.register() → datasets.json
  ← { ok, dataset, candleCount, skipped, warnings }

User: POST /api/ml/train { symbol, datasetId }
  → getDataset(datasetId) → filePath
  → spawn python3 train_pipeline.py --data <filePath> --symbol ... --output ...
```

---

## Constraints Honored

- **No fake market data** — all provider adapters fetch real data from live APIs.
- **No fallback_demo as historical source** — `historicalDataService` does not fall back to demo data; returns `no_candles_returned` if provider delivers nothing.
- **Provider limitations not hidden** — `providerCapabilities.js` documents every rate limit, lookback restriction, and credential requirement; `validateDateRange()` returns warnings; all warnings propagate to the API response.
- **No synthetic data** — candles are normalized from provider responses only; no generation.
- **No layout changes** — only a new sidebar entry was added; no existing workspace layouts were modified.
