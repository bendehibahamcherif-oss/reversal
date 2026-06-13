#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readDatasetCandlesAsync } from '../server/historical/historicalDataService.js';
import { historicalDatasetRegistry } from '../server/historical/historicalDatasetRegistry.js';

const DATASETS = [
  ['SPY', 'hist_SPY_1d_RTH_20250612_20260612_yahoo'],
  ['NFLX', 'hist_NFLX_1d_RTH_20250612_20260612_yahoo'],
];

const dateCandidates = ['date', 'timestamp', 'datetime', 'time'];
const closeCandidates = (symbol) => ['close', 'adjClose', 'Adj Close', 'adjusted_close', 'price', 'last', 'c', `close_${symbol}`, `${symbol}_close`];
const norm = (value) => String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
const findKey = (row, candidates) => Object.keys(row || {}).find((key) => candidates.map(norm).includes(norm(key))) || null;
const normalizeDate = (raw) => {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const prefix = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (prefix) return prefix[1];
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e9) return new Date(n > 1e12 ? n : n * 1000).toISOString().slice(0, 10);
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
};

function parseRows(symbol, candles) {
  const rows = (candles || []).map((row) => ({ ...row, symbol: row.symbol || symbol }));
  const dateColumn = rows.map((row) => findKey(row, dateCandidates)).find(Boolean) || null;
  const closeColumn = rows.map((row) => findKey(row, closeCandidates(symbol))).find(Boolean) || null;
  const parsed = rows.map((row) => {
    const dateKey = findKey(row, dateCandidates);
    const closeKey = findKey(row, closeCandidates(symbol));
    const date = normalizeDate(dateKey ? row[dateKey] : null);
    const close = Number(closeKey ? row[closeKey] : undefined);
    return { date, close: Number.isFinite(close) && close > 0 ? close : null };
  });
  const valid = parsed.filter((row) => row.date && Number.isFinite(row.close));
  valid.sort((a, b) => a.date.localeCompare(b.date));
  return { rows, dateColumn, closeColumn, parsed, valid };
}

function returnsByDate(valid) {
  const returns = new Map();
  for (let i = 1; i < valid.length; i += 1) {
    const prev = valid[i - 1].close;
    const next = valid[i].close;
    if (prev > 0 && Number.isFinite(next)) returns.set(valid[i].date, next / prev - 1);
  }
  return returns;
}

const parsedBySymbol = {};
for (const [symbol, datasetId] of DATASETS) {
  const record = historicalDatasetRegistry.get(datasetId);
  const filePath = record?.files?.csv || record?.files?.parquet || record?.files?.json || record?.filePath || null;
  const read = await readDatasetCandlesAsync(datasetId);
  const candles = read.ok ? read.candles : [];
  const info = parseRows(symbol, candles);
  parsedBySymbol[symbol] = info;
  console.log(JSON.stringify({
    datasetId,
    filePath,
    fileExists: Boolean(filePath && existsSync(filePath)),
    readOk: read.ok,
    readError: read.error || null,
    rawRowCount: candles.length,
    detectedColumns: [...new Set(candles.flatMap((row) => Object.keys(row || {})))],
    detectedDateColumn: info.dateColumn,
    detectedCloseColumn: info.closeColumn,
    parsedRowCount: info.valid.length,
    first5ParsedDates: info.valid.slice(0, 5).map((row) => row.date),
    last5ParsedDates: info.valid.slice(-5).map((row) => row.date),
    first5CloseValues: info.valid.slice(0, 5).map((row) => row.close),
    last5CloseValues: info.valid.slice(-5).map((row) => row.close),
    invalidDateRowsCount: info.parsed.filter((row) => !row.date).length,
    invalidCloseRowsCount: info.parsed.filter((row) => !Number.isFinite(row.close)).length,
  }, null, 2));
}

const spyDates = new Set(parsedBySymbol.SPY.valid.map((row) => row.date));
const nflxDates = new Set(parsedBySymbol.NFLX.valid.map((row) => row.date));
const commonDates = [...spyDates].filter((date) => nflxDates.has(date)).sort();
const spyReturns = returnsByDate(parsedBySymbol.SPY.valid);
const nflxReturns = returnsByDate(parsedBySymbol.NFLX.valid);
const commonReturnDates = [...spyReturns.keys()].filter((date) => nflxReturns.has(date)).sort();
const alignedRows = commonReturnDates.length;
let rootCause = null;
if (alignedRows === 0) {
  const missing = DATASETS.find(([, id]) => !historicalDatasetRegistry.get(id));
  if (missing) rootCause = 'dataset file missing';
  else if (!parsedBySymbol.SPY.dateColumn || !parsedBySymbol.NFLX.dateColumn) rootCause = 'no date column';
  else if (!parsedBySymbol.SPY.closeColumn || !parsedBySymbol.NFLX.closeColumn) rootCause = 'no close column';
  else if (parsedBySymbol.SPY.parsed.some((r) => !r.date) || parsedBySymbol.NFLX.parsed.some((r) => !r.date)) rootCause = 'parsed dates format mismatch';
  else if (parsedBySymbol.SPY.parsed.some((r) => !Number.isFinite(r.close)) || parsedBySymbol.NFLX.parsed.some((r) => !Number.isFinite(r.close))) rootCause = 'close values invalid';
  else if (commonDates.length === 0) rootCause = 'no overlapping dates';
  else rootCause = 'returns computed using different date keys';
}
console.log(JSON.stringify({
  spyDateCount: spyDates.size,
  nflxDateCount: nflxDates.size,
  commonDateCount: commonDates.length,
  first10CommonDates: commonDates.slice(0, 10),
  last10CommonDates: commonDates.slice(-10),
  returnCommonCount: commonReturnDates.length,
  alignedRows,
  rootCause,
}, null, 2));
