# Historical Dataset End-to-End Fix Report

## 1. Executive summary

The backend historical dataset contract now uses a canonical dataset object with both `datasetId` and `id`, normalized symbols, safe row counts, file metadata, and JSON-safe responses. Historical download accepts canonical `symbols: string[]` and legacy `symbol: string`. ML training, backtesting, macro correlation, and beta now resolve `datasetId` through the historical registry and return structured `dataset_not_found`, `dataset_file_missing`, or `not_enough_data` statuses instead of generic or undefined-driven failures.

Frontend files were requested, but this repository checkout contains only the backend service. No `src/` frontend tree exists under `/workspace/reversal`, so frontend code changes could not be made in this repository.

## 2. Root cause of `symbol_required`

Historical download had mixed contracts: callers send `symbols`, while the historical service was centered on a singular `symbol`. The route now normalizes canonical arrays and legacy strings, trims, uppercases, deduplicates, and rejects only an empty normalized list.

## 3. Root cause of `Dataset "undefined"`

The registry returned `id` but not `datasetId`. UI actions that referenced `dataset.datasetId` received `undefined`. The registry now normalizes every dataset to include both fields.

## 4. Root cause of `dataset_missing` after Use for ML

Because the selected dataset ID was undefined or omitted, `POST /api/ml/train` did not receive a resolvable historical dataset and fell back to default static dataset snapshot discovery. That fallback returned `dataset_missing`. Training now resolves `datasetId` directly and returns specific dataset errors.

## 5. Root cause of NaN in beta/correlation

Correlation/beta computations can produce non-finite values when observations are insufficient, variances are zero, or aligned rows are missing. The macro code now drops invalid rows, requires enough overlap, returns `null` for non-computable beta/r², and sanitizes all JSON responses.

## 6. Backend dataset object before/after

Before:

```json
{
  "id": "<uuid>",
  "symbol": "NFLX",
  "candleCount": 1234,
  "filePath": "...",
  "status": "ready"
}
```

After:

```json
{
  "datasetId": "hist_NFLX_1d_RTH_20210607_20260605_yahoo",
  "id": "hist_NFLX_1d_RTH_20210607_20260605_yahoo",
  "symbols": ["NFLX"],
  "symbol": "NFLX",
  "rowCount": 1234,
  "rowsBySymbol": { "NFLX": 1234 },
  "files": { "csv": null, "parquet": null, "json": "..." },
  "schema": "HistoricalCandle.v1",
  "status": "ready"
}
```

## 7. Frontend dataset object before/after

Expected frontend before was effectively partial and singular (`id`, `symbol`, `candleCount`, `filePath`). Expected frontend after is canonical (`datasetId`, `id`, `symbols`, `rowCount`, `rowsBySymbol`, `files`, `status`). Backend responses now support that object.

## 8. ML payload before/after

Before:

```json
{ "symbol": "SPY", "timeframe": "1d", "horizon": 10, "promote": false }
```

After:

```json
{ "symbol": "SPY", "timeframe": "1d", "horizon": 10, "datasetId": "hist_NFLX_1d_RTH_20210607_20260605_yahoo", "promote": false }
```

## 9. Backtest payload before/after

Before:

```json
{ "symbol": "NFLX", "timeframe": "1d", "strategy": { "type": "default_or_existing" } }
```

After:

```json
{ "datasetId": "hist_NFLX_1d_RTH_20210607_20260605_yahoo", "symbol": "NFLX", "timeframe": "1d", "strategy": { "type": "default_or_existing" } }
```

## 10. Correlation payload before/after

Before:

```text
GET /api/macro/correlation?symbols=NFLX,SPY&window=20
```

After:

```text
GET /api/macro/correlation?datasetId=hist_NFLX_1d_RTH_20210607_20260605_yahoo&symbols=NFLX,SPY&window=20
```

## 11. Backend files changed

- `server/historical/historicalDatasetRegistry.js`
- `server/historical/historicalDataService.js`
- `server/historical/jsonSafety.js`
- `server/api/historicalRoutes.js`
- `server/ai/trainingService.js`
- `server/api/mlRoutes.js`
- `server/api/backtestRoutes.js`
- `server/backtest/backtestEngine.js`
- `server/api/macroRoutes.js`
- `server/api/multiAssetRoutes.js`

## 12. Frontend files changed

None. The frontend repository/files listed in the mission are not present in this checkout.

## 13. Tests added

- Historical route tests for canonical `datasetId`, JSON safety, list/detail normalization, and structured not found.
- Consumer tests for ML dataset resolution and errors.
- Consumer tests for backtest dataset resolution and `dataSource.datasetId`.
- Consumer tests for correlation/beta non-NaN behavior and not-enough-data contracts.

## 14. Validation results

- `npm test` passed.
- `npm run build` passed.
- `npm run frontend:build` is not available in this backend package.

Manual UI validation could not be performed because no frontend application is present in this repository checkout.

## 15. Remaining limitations

- Frontend contract changes still need to be applied in the separate `intraday-reversal-engine` repository.
- Historical files are currently stored as JSON by the existing backend provider path. The registry exposes `files.csv`, `files.parquet`, and `files.json`; ML accepts JSON files for historical datasets, but CSV/parquet export generation is not implemented in this checkout.
