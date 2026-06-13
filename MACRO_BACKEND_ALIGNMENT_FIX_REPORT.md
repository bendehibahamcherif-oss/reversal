# Macro Backend Alignment Fix Report

## Production Route Discovery

- `server.js` starts the Express app and applies runtime integration.
- `server/bootstrap/runtimeIntegration.js` mounts:
  - `app.use('/api/multi-asset', multiAssetRoutes)`
  - `app.use('/api/macro', macroRoutes)`
- The production handlers for the urgent routes are in `server/api/macroRoutes.js`:
  - `GET /api/macro/correlation` -> `macroRoutes.get('/correlation', ...)`
  - `GET /api/macro/beta` -> `macroRoutes.get('/beta', ...)`
- Correlation is computed by `correlationFromPairs(...)` over `alignedPairs(...)` from `groupedReturns(...)`.
- Beta and R² are computed by `betaFromPairs(...)` over the same return-date alignment path.
- Dataset loading uses `resolveAndLoadCandles(...)`, which calls `readDatasetCandlesAsync(...)` from `server/historical/historicalDataService.js` and, for auto-resolution, `findCompatibleDatasetsForSymbols(...)` / `loadCandlesFromMultipleDatasets(...)` from `server/services/dataRequirementService.js`.

## Exact Root Cause

The production route was mounted correctly, but the backend alignment path had multiple fragile assumptions that could produce `alignedRows: 0` even when the UI selected compatible datasets:

1. **Explicit multi-dataset order was not honored for beta requests.**
   - Beta internally used `[asset, benchmark]` as the symbol order.
   - A request such as `asset=NFLX&benchmark=SPY&symbols=SPY,NFLX&datasetIds=hist_SPY...,hist_NFLX...` could map the first dataset to the asset instead of the first explicitly requested symbol.
   - The fix uses the explicit `symbols` query order for `datasetIds` positional mapping while still computing beta for `asset` vs `benchmark`.

2. **Column detection was too narrow.**
   - Date and close extraction depended on a small set of exact field names.
   - The fix detects date and close columns case-insensitively, trims field names, supports Yahoo-style `Date`/`Close`, ISO datetimes, `Timestamp`, `Adj Close`, symbol-specific `close_SPY`, `SPY_close`, `close_NFLX`, and `NFLX_close`.

3. **Daily dates were not normalized consistently before sorting/alignment.**
   - The fix normalizes daily date-like values to `YYYY-MM-DD` and sorts by normalized date keys.

4. **Zero-alignment responses did not include enough root-cause diagnostics.**
   - The fix adds structured diagnostics for raw rows, parsed rows, detected columns, invalid date/close rows, common dates, and root cause.

## Route Fixed

- `server/api/macroRoutes.js`
  - `GET /api/macro/correlation`
  - `GET /api/macro/beta`

## Loader Fixed

- `server/historical/historicalDataService.js`
  - `parseCsvCandles(...)`
  - `readDatasetCandlesAsync(...)` continues to be the production dataset loader; CSV parsing is now more robust for Yahoo-style shapes and symbol-specific close columns.

## Debug Script Added

- `scripts/debug-macro-alignment.js`

### Local Debug Output for Requested Dataset IDs

The exact requested production dataset IDs are not present in this local workspace registry, so the debug script correctly reports structured missing-dataset diagnostics rather than silently returning zero alignment:

- SPY dataset: `hist_SPY_1d_RTH_20250612_20260612_yahoo`
  - file path: `null`
  - file exists: `false`
  - read error: `dataset_not_found`
  - raw rows: `0`
  - date column: `null`
  - close column: `null`
  - parsed rows: `0`

- NFLX dataset: `hist_NFLX_1d_RTH_20250612_20260612_yahoo`
  - file path: `null`
  - file exists: `false`
  - read error: `dataset_not_found`
  - raw rows: `0`
  - date column: `null`
  - close column: `null`
  - parsed rows: `0`

- common date count: `0`
- aligned rows: `0`
- root cause: `dataset file missing`

## Regression Fixture Results

The new regression tests create the required SPY and NFLX Yahoo-style fixture files:

- SPY: lowercase `date` / `close`
- NFLX: uppercase `Date` / `Close`

The tests verify:

1. Correlation `SPY,NFLX` with explicit `datasetIds` returns `alignedRows >= 5`.
2. Matrix is `2x2`.
3. Matrix values are finite.
4. Beta `NFLX` vs `SPY` returns finite beta.
5. R² is finite.
6. `date` vs `Date` columns align.
7. ISO datetime vs `YYYY-MM-DD` align.
8. Missing close column returns `no_close_column`.
9. No overlap returns `no_overlap` diagnostics.
10. `datasetIds` order maps correctly to symbols.

## After-Fix Behavior Proven Locally

Using fixture datasets in `server/tests/macroAlignmentRoutes.test.js`:

- Date columns detected: `date` for SPY and `Date` for NFLX.
- Close columns detected: `close` for SPY and `Close` for NFLX.
- Parsed rows: 10 SPY and 10 NFLX.
- Return common count / aligned rows: 9.
- Correlation result: finite 2x2 matrix.
- Beta result: finite `beta` and finite `r2`.

## Production Smoke Result

Command attempted:

```bash
API_BASE=https://reversal.onrender.com node scripts/production-macro-alignment-smoke.js
```

Result in this execution environment:

- Failed before reaching the app because outbound access to `https://reversal.onrender.com` failed (`CONNECT tunnel failed, response 403` / DNS `EAI_AGAIN`).
- No production app JSON response was available from this environment.
- The smoke script itself is committed and will verify:
  - correlation aligned rows `> 20`
  - finite correlation
  - beta aligned rows `> 20`
  - finite beta
  - finite R²
  - structured missing-dataset/no-HTML/no-500 behavior if datasets are unavailable.

## Validation Commands

- `npm test` — passed locally.
- `npm run build` — passed locally.
- `node scripts/debug-macro-alignment.js` — passed locally and reported missing local dataset files with diagnostics.
- `node scripts/backend-route-discovery.js` — passed locally.
- `node scripts/api-contract-crawler.js` — passed locally.
- `node scripts/payload-fuzzer.js` — passed locally.
- `API_BASE=https://reversal.onrender.com node scripts/production-api-contract-smoke.js` — failed due environment network/proxy access to Render, not an app JSON failure.
- `API_BASE=https://reversal.onrender.com node scripts/production-macro-alignment-smoke.js` — failed due environment network/proxy access to Render, not an app JSON failure.
