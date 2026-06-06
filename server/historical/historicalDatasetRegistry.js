import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

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
    return JSON.parse(readFileSync(REGISTRY_FILE, 'utf-8'));
  } catch {
    return { version: 1, datasets: [] };
  }
}

function saveRegistry(reg) {
  ensureDirs();
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}

export const historicalDatasetRegistry = {
  /**
   * List all datasets, optionally filtered by symbol/timeframe/provider.
   */
  list({ symbol, timeframe, provider, purpose } = {}) {
    const reg = loadRegistry();
    let datasets = reg.datasets || [];
    if (symbol)    datasets = datasets.filter((d) => d.symbol    === String(symbol).toUpperCase());
    if (timeframe) datasets = datasets.filter((d) => d.timeframe === timeframe);
    if (provider)  datasets = datasets.filter((d) => d.provider  === provider);
    if (purpose)   datasets = datasets.filter((d) => d.purpose   === purpose);
    return datasets.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },

  /**
   * Get a dataset by id.
   */
  get(id) {
    const reg = loadRegistry();
    return (reg.datasets || []).find((d) => d.id === id) ?? null;
  },

  /**
   * Register a new dataset record.
   * Returns the full dataset metadata object.
   */
  register({ symbol, timeframe, provider, startDate, endDate, candleCount, filePath, fileSize, purpose = 'general', sourceType = 'market_data', warnings = [] }) {
    const reg = loadRegistry();
    const id = randomUUID();
    const dataset = {
      id,
      symbol:      String(symbol || '').toUpperCase(),
      timeframe:   String(timeframe || '1d'),
      provider:    String(provider || 'unknown'),
      startDate:   String(startDate || ''),
      endDate:     String(endDate || ''),
      candleCount: Number(candleCount) || 0,
      filePath:    String(filePath || ''),
      fileSize:    Number(fileSize) || 0,
      purpose:     String(purpose || 'general'),
      sourceType:  String(sourceType || 'market_data'),
      warnings,
      createdAt:   Date.now(),
      status:      'ready',
    };
    if (!Array.isArray(reg.datasets)) reg.datasets = [];
    reg.datasets.push(dataset);
    saveRegistry(reg);
    return dataset;
  },

  /**
   * Delete a dataset record (does not delete the file itself).
   */
  delete(id) {
    const reg = loadRegistry();
    const before = (reg.datasets || []).length;
    reg.datasets = (reg.datasets || []).filter((d) => d.id !== id);
    const deleted = before > reg.datasets.length;
    if (deleted) saveRegistry(reg);
    return deleted;
  },

  /**
   * Update dataset status or metadata fields.
   */
  update(id, patch) {
    const reg = loadRegistry();
    const idx = (reg.datasets || []).findIndex((d) => d.id === id);
    if (idx === -1) return null;
    reg.datasets[idx] = { ...reg.datasets[idx], ...patch };
    saveRegistry(reg);
    return reg.datasets[idx];
  },

  getDirectories() {
    return { DATA_DIR, RAW_DIR, ML_DIR, BACKTEST_DIR, CORRELATION_DIR };
  },
};
