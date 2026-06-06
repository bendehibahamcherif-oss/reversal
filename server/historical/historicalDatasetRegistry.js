import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID, createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data/historical');
const REGISTRY_FILE = join(DATA_DIR, 'datasets.json');
const RAW_DIR = join(DATA_DIR, 'raw');
const ML_DIR = join(DATA_DIR, 'ml');
const BACKTEST_DIR = join(DATA_DIR, 'backtest');
const CORRELATION_DIR = join(DATA_DIR, 'correlation');

function ensureDirs() {
  for (const dir of [DATA_DIR, RAW_DIR, ML_DIR, BACKTEST_DIR, CORRELATION_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function loadRegistry() {
  ensureDirs();
  if (!existsSync(REGISTRY_FILE)) {
    writeFileSync(REGISTRY_FILE, JSON.stringify({ version: 1, datasets: [] }, null, 2));
    return { version: 1, datasets: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
    return { version: parsed.version || 1, datasets: Array.isArray(parsed.datasets) ? parsed.datasets : [] };
  } catch {
    return { version: 1, datasets: [] };
  }
}

function saveRegistry(reg) {
  ensureDirs();
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

function normalizeSymbols(dataset = {}) {
  const raw = Array.isArray(dataset.symbols)
    ? dataset.symbols
    : dataset.symbol
      ? [dataset.symbol]
      : [];
  return raw.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean).filter((s, i, arr) => arr.indexOf(s) === i);
}

function stableDatasetId(dataset = {}) {
  const existing = dataset.datasetId || dataset.id;
  if (existing) return String(existing);
  const symbols = normalizeSymbols(dataset).join('_') || String(dataset.symbol || 'UNKNOWN').toUpperCase();
  const compact = (value) => String(value || '').replace(/[^0-9A-Za-z]/g, '') || 'na';
  return `hist_${symbols}_${dataset.timeframe || '1d'}_${dataset.session || 'RTH'}_${compact(dataset.startDate)}_${compact(dataset.endDate)}_${dataset.provider || 'unknown'}_${randomUUID().slice(0, 8)}`;
}

function normalizeFiles(dataset = {}) {
  if (dataset.files && typeof dataset.files === 'object' && !Array.isArray(dataset.files)) {
    return {
      csv: dataset.files.csv ?? null,
      parquet: dataset.files.parquet ?? null,
      json: dataset.files.json ?? dataset.filePath ?? null,
    };
  }
  return {
    csv: dataset.filePath && String(dataset.filePath).endsWith('.csv') ? dataset.filePath : null,
    parquet: dataset.filePath && String(dataset.filePath).endsWith('.parquet') ? dataset.filePath : null,
    json: dataset.filePath && String(dataset.filePath).endsWith('.json') ? dataset.filePath : null,
  };
}

export function normalizeHistoricalDataset(dataset = {}) {
  const datasetId = stableDatasetId(dataset);
  const symbols = normalizeSymbols(dataset);
  const rowCount = Number.isFinite(Number(dataset.rowCount))
    ? Number(dataset.rowCount)
    : Number.isFinite(Number(dataset.candleCount))
      ? Number(dataset.candleCount)
      : 0;
  const rowsBySymbol = dataset.rowsBySymbol && typeof dataset.rowsBySymbol === 'object' && !Array.isArray(dataset.rowsBySymbol)
    ? dataset.rowsBySymbol
    : Object.fromEntries(symbols.map((symbol) => [symbol, rowCount]));
  const files = normalizeFiles(dataset);
  const filePath = dataset.filePath || files.csv || files.parquet || files.json || '';
  return {
    ...dataset,
    datasetId,
    id: dataset.id || datasetId,
    symbol: dataset.symbol ? String(dataset.symbol).toUpperCase() : (symbols[0] || ''),
    symbols,
    timeframe: String(dataset.timeframe || '1d'),
    provider: String(dataset.provider || 'unknown'),
    startDate: String(dataset.startDate || ''),
    endDate: String(dataset.endDate || ''),
    session: String(dataset.session || 'RTH'),
    purpose: String(dataset.purpose || 'general'),
    rowCount,
    rowsBySymbol,
    files,
    filePath,
    schema: dataset.schema || 'HistoricalCandle.v1',
    dataHash: dataset.dataHash || '',
    status: dataset.status || 'ready',
    createdAt: dataset.createdAt || new Date().toISOString(),
    warnings: Array.isArray(dataset.warnings) ? dataset.warnings : [],
  };
}

function filterDataset(dataset, { symbol, timeframe, provider, purpose } = {}) {
  if (symbol && !dataset.symbols.includes(String(symbol).toUpperCase())) return false;
  if (timeframe && dataset.timeframe !== timeframe) return false;
  if (provider && dataset.provider !== provider) return false;
  if (purpose && dataset.purpose !== purpose) return false;
  return true;
}

function hashDataset(dataset) {
  const input = JSON.stringify({
    symbols: dataset.symbols,
    timeframe: dataset.timeframe,
    provider: dataset.provider,
    startDate: dataset.startDate,
    endDate: dataset.endDate,
    rowCount: dataset.rowCount,
    files: dataset.files,
  });
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export const historicalDatasetRegistry = {
  list(filters = {}) {
    const reg = loadRegistry();
    const datasets = (reg.datasets || []).map(normalizeHistoricalDataset).filter((d) => filterDataset(d, filters));
    return datasets.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  },

  listDatasets(filters = {}) {
    return this.list(filters);
  },

  get(datasetId) {
    const wanted = String(datasetId || '');
    if (!wanted) return null;
    const reg = loadRegistry();
    const found = (reg.datasets || []).find((d) => String(d.datasetId || '') === wanted || String(d.id || '') === wanted);
    return found ? normalizeHistoricalDataset(found) : null;
  },

  getDataset(datasetId) {
    return this.get(datasetId);
  },

  saveDataset(dataset) {
    const normalized = normalizeHistoricalDataset(dataset);
    if (!normalized.datasetId) throw new Error('datasetId_required');
    if (!normalized.dataHash) normalized.dataHash = hashDataset(normalized);
    const reg = loadRegistry();
    if (!Array.isArray(reg.datasets)) reg.datasets = [];
    const idx = reg.datasets.findIndex((d) => d.datasetId === normalized.datasetId || d.id === normalized.datasetId || d.datasetId === normalized.id || d.id === normalized.id);
    if (idx === -1) reg.datasets.push(normalized);
    else reg.datasets[idx] = { ...reg.datasets[idx], ...normalized };
    saveRegistry(reg);
    return normalized;
  },

  register({ symbol, symbols, timeframe, provider, startDate, endDate, candleCount, rowCount, rowsBySymbol, filePath, files, fileSize, purpose = 'general', session = 'RTH', sourceType = 'market_data', warnings = [], datasetId }) {
    const normalizedSymbols = normalizeSymbols({ symbol, symbols });
    const count = Number(rowCount ?? candleCount) || 0;
    const dataset = normalizeHistoricalDataset({
      datasetId,
      id: datasetId,
      symbol: normalizedSymbols[0] || symbol,
      symbols: normalizedSymbols,
      timeframe,
      provider,
      startDate,
      endDate,
      session,
      purpose,
      rowCount: count,
      candleCount: count,
      rowsBySymbol: rowsBySymbol || Object.fromEntries(normalizedSymbols.map((s) => [s, count])),
      files,
      filePath,
      fileSize: Number(fileSize) || 0,
      sourceType,
      warnings,
      schema: 'HistoricalCandle.v1',
      createdAt: new Date().toISOString(),
      status: 'ready',
    });
    return this.saveDataset(dataset);
  },

  delete(id) {
    const reg = loadRegistry();
    const before = (reg.datasets || []).length;
    reg.datasets = (reg.datasets || []).filter((d) => d.id !== id && d.datasetId !== id);
    const deleted = before > reg.datasets.length;
    if (deleted) saveRegistry(reg);
    return deleted;
  },

  update(id, patch) {
    const reg = loadRegistry();
    const idx = (reg.datasets || []).findIndex((d) => d.id === id || d.datasetId === id);
    if (idx === -1) return null;
    reg.datasets[idx] = normalizeHistoricalDataset({ ...reg.datasets[idx], ...patch });
    saveRegistry(reg);
    return reg.datasets[idx];
  },

  getDirectories() {
    return { DATA_DIR, REGISTRY_FILE, RAW_DIR, ML_DIR, BACKTEST_DIR, CORRELATION_DIR };
  },
};
