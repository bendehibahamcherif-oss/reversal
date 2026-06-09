# Mobile Historical Data Layout & Multi-Dataset Correlation Fix

**Date:** 2026-06-09  
**Scope:** Backend (`reversal`) + Frontend (`intraday-reversal-engine`)

---

## Summary

Two independent fixes shipped in one coordinated commit pair:

1. **Mobile layout** — `HistoricalDataWorkspace` is now single-column on ≤ 768 px with no horizontal body overflow
2. **Multi-dataset correlation** — Macro workspace auto-combines separate single-symbol datasets (e.g. `hist_SPY_1d_...` + `hist_NFLX_1d_...`) instead of returning `missing_symbols`

---

## Part A — Mobile Historical Data Layout Fix

### Problem
`HistoricalDataWorkspace.jsx` used fixed `gridTemplateColumns: '1fr 1fr'` / `'1fr 1fr 1fr 1fr'` inline styles.  
On narrow screens (≤ 768 px) this caused horizontal overflow because inline styles cannot use `@media` queries.

### Fix (frontend)

**`src/workspaces/HistoricalDataWorkspace.jsx`**
- Added `useWindowWidth()` hook — listens to `window.resize`, returns current width
- `isMobile = useWindowWidth() <= 768` computed in `DownloadForm`, `DatasetDetail`, and `HistoricalDataWorkspace`
- Grid columns made conditional:
  - `DownloadForm` provider/timeframe filter row: `isMobile ? '1fr 1fr' : '1fr 1fr 1fr 1fr'`
  - `DownloadForm` date-range row: `isMobile ? '1fr' : '1fr 1fr'`
  - `DatasetDetail` metadata grid: `isMobile ? '1fr 1fr' : '1fr 1fr 1fr 1fr'`
  - Main dataset split (list + detail): `isMobile ? '1fr' : '1fr 1fr'`
- `DatasetTable` wrapped in `overflowX: 'auto'` container — table with 10 columns scrolls horizontally rather than overflowing the body
- `S.root` and `S.body`: `maxWidth: '100%'`, `boxSizing: 'border-box'`

### E2E Test (Playwright)

**`tests/e2e/historical-mobile-layout.spec.ts`** — 3 test cases:
1. `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1` (no horizontal body overflow)
2. Tab switch (Datasets → Download → Providers) does not re-introduce overflow
3. No `NaN` or `undefined` values in rendered text

**`playwright.config.ts`** — mobile-chrome project using `iPhone 14` device preset (390 × 844)

---

## Part B/C — Multi-Dataset Correlation Auto-Resolution

### Problem
`GET /api/macro/correlation?datasetId=<spy_id>&symbols=SPY,NFLX` returned `missing_symbols` when `NFLX` was absent from the primary dataset, even if a separate `hist_NFLX_1d_...` dataset existed in the registry.

### Backend Fix

**`server/services/dataRequirementService.js`** (new)
```
findCompatibleDatasetsForSymbols({ symbols, timeframe })
  → { datasetsBySymbol: { "NFLX": "hist_nflx_id" }, missingSymbols: [] }

loadCandlesFromMultipleDatasets(datasetsBySymbol)
  → { ok, candles: [...merged...], failedDatasets: [] }
```

**`server/api/macroRoutes.js`**
- `parseDatasetIds(raw)` — parses `?datasetIds=id1,id2,...`
- `resolveAndLoadCandles(primaryDatasetId, datasetIds, symbols, res)` — three-mode candle loader:
  - **A** explicit `datasetIds` → load each, merge candles
  - **B** single `datasetId` → load primary, auto-resolve missing symbols from registry via `findCompatibleDatasetsForSymbols`
  - **C** no dataset → returns empty / `not_enough_data`
- `/correlation` and `/beta` endpoints: accept `datasetIds` param, return `resolution` + `datasetsBySymbol` in every response, add `action: 'create_dataset'` to `missing_symbols` when no registry match found
- `datasetCandlesResponse` (volatility-heatmap, sector-rotation) unchanged

### Frontend Fix

**`src/services/dataRequirementResolver.js`** (new)
```
resolveDatasets({ symbols, timeframe, selectedDatasetId, allDatasets })
  → { status: 'single_dataset' | 'multi_dataset' | 'missing_symbols' | 'no_dataset_selected',
      datasetIds, datasetsBySymbol, missingSymbols }
```

**`src/store/macroStore.js`**
- `loadCorrelation` / `loadBeta` call `resolveDatasets` using `useHistoricalDataStore.getState().datasets`
- Pass `datasetIds` when `resolution.status === 'multi_dataset'`, otherwise fall back to single `datasetId`

**`src/api.js`**
- `getMultiAssetCorrelation` / `getMultiAssetBeta`: accept `datasetIds` array param, serialize as comma-separated `?datasetIds=`
- `getHistoricalDatasetDiagnostics(datasetId)` added (was missing, used by `historicalDataStore`)

**`src/workspaces/MacroWorkspace.jsx`**
- `MissingSymbolsError`: shows "Download a dataset for `{sym}`" CTA when `data.action === 'create_dataset'`
- `CorrelationMatrix`: "✓ Using compatible datasets: SPY → ..., NFLX → ..." banner when `correlation.resolution === 'multi_dataset'`
- `not_enough_data` section: shows `alignedRows` and `requiredRows` threshold

---

## Part D — New Tests

### Backend: `server/tests/macroRoutes.test.js` (5 new tests, 103 total)

| Test | Assertion |
|------|-----------|
| Auto-resolve SPY from NFLX-only primary | `ok=true`, `status=ready`, `resolution=multi_dataset` |
| Explicit `datasetIds=spy_id,nflx_id` | `ok=true`, `status=ready`, `resolution=multi_dataset` |
| Missing MSFT (no registry match) | `ok=false`, `status=missing_symbols`, `action=create_dataset` |
| Beta auto-resolve NFLX from SPY-only primary | `ok=true`, `status=ready`, `resolution=multi_dataset` |
| Beta missing MSFT | `ok=false`, `status=missing_symbols`, `action=create_dataset` |

New fixtures:
- `writeNflxOnlyCsv(dir)` — 60-row single-symbol NFLX CSV
- `patchRegistryWithSymbol(datasetId, csvPath, symbol)` — patches registry with explicit `symbol`/`symbols` fields for auto-resolution

Existing tests updated: "NFLX missing" → "MSFT missing" (since NFLX now auto-resolves).

### Frontend: `tests/e2e/historical-mobile-layout.spec.ts` (Playwright, 3 tests)

---

## Validation Results

| Check | Result |
|-------|--------|
| Backend `npm test` | **103/103 pass** (98 original + 5 new) |
| Backend smoke `node scripts/full-backend-smoke.js` | **47/47 pass** |
| Frontend `npx vitest run` | **88/88 pass** |
| Playwright E2E | Requires dev server (run `npm run dev` + `npx playwright test`) |

---

## Non-Negotiable Rules — Compliance

| Rule | Status |
|------|--------|
| Do not fake correlation values | COMPLIANT — real Pearson correlation from real candle data |
| Do not show empty matrix silently | COMPLIANT — `not_enough_data` shows row counts and threshold |
| Do not remove modules | COMPLIANT |
| Do not hide modules | COMPLIANT |
| Do not weaken tests | COMPLIANT — existing assertions preserved, 5 new tests added |
| No mock data introduced | COMPLIANT |
| No fake provider connectivity | COMPLIANT |
