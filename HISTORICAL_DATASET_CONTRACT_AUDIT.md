# Historical Dataset Contract Audit

## Scope audited

Backend files audited:
- `server/historical/historicalDataService.js`
- `server/historical/historicalDatasetRegistry.js`
- `server/historical/providerCapabilities.js`
- `server/historical/providers/*`
- `server/api/historicalRoutes.js`
- `server/api/mlRoutes.js`
- `server/ai/trainingService.js`
- `server/api/backtestRoutes.js`
- `server/api/macroRoutes.js`
- `server/api/multiAssetRoutes.js`

Frontend files requested by the mission were not present in this repository. This checkout contains the backend repo `reversal`; there is no `src/` tree or frontend package in `/workspace/reversal`.

## 1. Backend shape returned by `POST /api/historical/download`

Before fix, successful responses were:

```json
{
  "ok": true,
  "symbols": ["NFLX"],
  "dataset": {
    "id": "<uuid>",
    "symbol": "NFLX",
    "timeframe": "1d",
    "provider": "yahoo",
    "startDate": "2025-06-06",
    "endDate": "2026-06-06",
    "candleCount": 2,
    "filePath": "server/data/historical/raw/NFLX_1d_yahoo_<timestamp>.json",
    "fileSize": 1234,
    "purpose": "general",
    "sourceType": "market_data",
    "warnings": [],
    "createdAt": 1710000000000,
    "status": "ready"
  },
  "datasets": ["<same shape>"],
  "candleCount": 2,
  "skipped": 0,
  "warnings": []
}
```

After fix, successful responses are JSON-safe and include canonical dataset metadata:

```json
{
  "ok": true,
  "symbols": ["NFLX"],
  "dataset": {
    "datasetId": "hist_NFLX_1d_RTH_20250606_20260606_yahoo",
    "id": "hist_NFLX_1d_RTH_20250606_20260606_yahoo",
    "provider": "yahoo",
    "symbols": ["NFLX"],
    "symbol": "NFLX",
    "timeframe": "1d",
    "startDate": "2025-06-06",
    "endDate": "2026-06-06",
    "session": "RTH",
    "purpose": "general",
    "rowCount": 2,
    "rowsBySymbol": { "NFLX": 2 },
    "files": { "csv": null, "parquet": null, "json": "server/data/historical/raw/<datasetId>.json" },
    "schema": "HistoricalCandle.v1",
    "dataHash": "sha256:...",
    "status": "ready",
    "createdAt": "2026-06-06T...Z",
    "warnings": []
  },
  "datasets": ["<same canonical shape>"],
  "candleCount": 2,
  "skipped": 0,
  "warnings": []
}
```

Missing symbols now returns:

```json
{
  "ok": false,
  "status": "symbol_required",
  "message": "At least one symbol is required.",
  "expected": { "symbols": ["SPY", "QQQ"] }
}
```

## 2. Backend shape returned by `GET /api/historical/datasets`

Before fix:

```json
{
  "ok": true,
  "datasets": [
    {
      "id": "<uuid>",
      "symbol": "NFLX",
      "candleCount": 2,
      "filePath": "..."
    }
  ],
  "count": 1
}
```

After fix:

```json
{
  "ok": true,
  "datasets": [
    {
      "datasetId": "hist_NFLX_1d_RTH_20250606_20260606_yahoo",
      "id": "hist_NFLX_1d_RTH_20250606_20260606_yahoo",
      "symbols": ["NFLX"],
      "rowCount": 2,
      "rowsBySymbol": { "NFLX": 2 },
      "files": { "csv": null, "parquet": null, "json": "..." },
      "status": "ready"
    }
  ],
  "count": 1
}
```

## 3. Backend shape returned by `GET /api/historical/datasets/:datasetId`

Before fix, only `id` lookup was supported and not-found responses were `{ "ok": false, "error": "dataset_not_found" }`.

After fix:

```json
{ "ok": true, "dataset": { "datasetId": "...", "id": "..." } }
```

Not found:

```json
{
  "ok": false,
  "status": "dataset_not_found",
  "message": "Historical dataset not found.",
  "datasetId": "missing_dataset"
}
```

## 4. Frontend object expected by Historical Data detail

Requested frontend detail expects a dataset object with:

```json
{
  "datasetId": "...",
  "id": "...",
  "provider": "yahoo",
  "symbols": ["NFLX"],
  "timeframe": "1d",
  "startDate": "2021-06-07",
  "endDate": "2026-06-05",
  "session": "RTH",
  "purpose": "general",
  "rowCount": 1234,
  "rowsBySymbol": { "NFLX": 1234 },
  "files": { "csv": "...", "parquet": null, "json": null },
  "status": "ready",
  "warnings": []
}
```

## 5. Field used by "Use for ML Training"

Before fix, backend records exposed `id` only while the intended cross-module field was `datasetId`. That mismatch allowed frontend code to build messages and payloads with `dataset.datasetId` as `undefined`.

After fix, backend always returns both `datasetId` and `id`.

## 6. Field used by "Use for Backtesting"

Backtesting accepts `datasetId` in request bodies. Before fix, it attempted to read the dataset and passed candles into `runBacktest`, but `runBacktest` ignored the candle argument. After fix, `datasetId` resolves through the registry, file errors are structured, and the response includes `dataSource.datasetId`.

## 7. Field used by "Use for Correlation"

Macro and multi-asset correlation accept `datasetId` as a query parameter. Before fix, macro ignored it and multi-asset only checked for a record. After fix, dataset files are loaded and used for return alignment.

## 8. Exact ML train payload before fix

The observed broken frontend payload effectively became:

```json
{
  "symbol": "SPY",
  "timeframe": "1d",
  "horizon": 10,
  "promote": false
}
```

or contained an undefined JavaScript property that disappeared during `JSON.stringify`. Backend then returned `dataset_missing` because it had no `datasetId` and no `datasetPath`.

## 9. Exact Backtest payload before fix

The broken payload was susceptible to:

```json
{
  "symbol": "NFLX",
  "timeframe": "1d",
  "strategy": { "type": "default_or_existing" }
}
```

with no usable `datasetId`.

## 10. Exact Correlation payload before fix

The broken request was susceptible to omitting the dataset query entirely:

```text
GET /api/macro/correlation?symbols=NFLX,SPY&window=20
```

or sending `datasetId=undefined` from UI state.

## 11. Root cause of `Dataset "undefined"`

Historical records returned only `id`; the destination action/message used `dataset.datasetId`. The property did not exist, so the message interpolated JavaScript `undefined`.

## 12. Root cause of `dataset_missing` after selecting dataset

The ML train endpoint only had a dataset when `datasetPath` was supplied or when `datasetId` was correctly propagated and resolved. Because the selected dataset ID was undefined/omitted, `trainingService` fell back to static snapshot paths and returned `dataset_missing`.

## 13. Root cause of `symbol_required`

The backend service accepted `symbol`, while the canonical frontend request uses `symbols`. Route-level normalization existed, but the service remained single-symbol and registry metadata stayed singular. This was hardened so canonical `symbols: ["NFLX"]` and legacy `symbol: "NFLX"` both normalize before rejection.

## 14. Contract mismatches

- `id` vs `datasetId`: registry wrote `id`; downstream workflows expected `datasetId`.
- `symbol` vs `symbols`: historical service/registry wrote `symbol`; UI/download contract uses `symbols` array.
- `candleCount`/`filePath` vs `rowCount`/`files`: detail screens need row/file fields; old records did not expose them.
- Not-found errors used `error`; destination workflows require `status` and `message`.
