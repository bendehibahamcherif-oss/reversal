/**
 * Data-requirement resolution service.
 * Finds compatible datasets across the registry for multi-symbol analytics.
 */
import { listDatasets, readDatasetCandlesAsync } from '../historical/historicalDataService.js';

/**
 * Find the best compatible dataset for each requested symbol.
 * Compatible = status ready, matching timeframe (if given), contains the symbol.
 *
 * @param {{ symbols: string[], timeframe?: string }} opts
 * @returns {{ datasetsBySymbol: Record<string,string>, missingSymbols: string[] }}
 */
export function findCompatibleDatasetsForSymbols({ symbols, timeframe }) {
  const all = listDatasets();
  const ready = all.filter((d) => d.status === 'ready');

  const datasetsBySymbol = {};
  const missingSymbols = [];

  for (const sym of symbols) {
    const symUpper = sym.toUpperCase();
    const candidates = ready.filter((d) => {
      // Check symbols array (normalized) or symbol string
      const dsSymbols = Array.isArray(d.symbols)
        ? d.symbols.map((s) => String(s).toUpperCase())
        : d.symbol ? [String(d.symbol).toUpperCase()] : [];
      if (!dsSymbols.includes(symUpper)) return false;
      if (timeframe && d.timeframe && d.timeframe !== timeframe) return false;
      return true;
    });

    if (candidates.length === 0) {
      missingSymbols.push(sym);
    } else {
      // Prefer most rows, then most recent
      candidates.sort((a, b) => {
        const rowsA = Number(a.rowCount ?? a.candleCount ?? 0);
        const rowsB = Number(b.rowCount ?? b.candleCount ?? 0);
        return rowsB - rowsA;
      });
      datasetsBySymbol[symUpper] = candidates[0].datasetId || candidates[0].id;
    }
  }

  return { datasetsBySymbol, missingSymbols };
}

/**
 * Load candles from multiple datasets (by datasetId), filtered to only the
 * symbols we need from each dataset, then merged into one flat array.
 *
 * @param {Record<string,string>} datasetsBySymbol  { "SPY": "ds_id_1", "NFLX": "ds_id_2" }
 * @returns {Promise<{ ok: boolean, candles: object[], failedDatasets: string[] }>}
 */
export async function loadCandlesFromMultipleDatasets(datasetsBySymbol) {
  // Deduplicate dataset IDs (multiple symbols may share one dataset)
  const byDatasetId = new Map(); // dsId -> [symbols]
  for (const [sym, dsId] of Object.entries(datasetsBySymbol)) {
    if (!byDatasetId.has(dsId)) byDatasetId.set(dsId, []);
    byDatasetId.get(dsId).push(sym.toUpperCase());
  }

  const allCandles = [];
  const failedDatasets = [];

  for (const [dsId, syms] of byDatasetId) {
    const result = await readDatasetCandlesAsync(dsId);
    if (!result.ok) {
      failedDatasets.push(dsId);
      continue;
    }
    const relevant = result.candles.filter((c) =>
      syms.includes(String(c.symbol || '').toUpperCase()),
    );
    allCandles.push(...relevant);
  }

  return {
    ok: allCandles.length > 0 || failedDatasets.length === 0,
    candles: allCandles,
    failedDatasets,
  };
}
