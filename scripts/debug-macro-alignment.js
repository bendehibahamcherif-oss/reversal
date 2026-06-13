#!/usr/bin/env node
/**
 * Alignment diagnostic — shows exactly what file is read, the raw candle[0] keys,
 * the first 5 timeOf() outputs, and the intersection size for two datasets.
 *
 * Usage:
 *   node scripts/debug-macro-alignment.js [SPY_ID] [NFLX_ID]
 *
 * Defaults to the production IDs:
 *   hist_SPY_1d_RTH_20250501_20260613_yahoo
 *   hist_NFLX_1d_RTH_20250501_20260613_yahoo
 */

import { existsSync } from 'node:fs';
import { readDatasetCandlesAsync } from '../server/historical/historicalDataService.js';
import { historicalDatasetRegistry } from '../server/historical/historicalDatasetRegistry.js';

const [,, argA, argB] = process.argv;
const DATASETS = [
  ['SPY',  argA || 'hist_SPY_1d_RTH_20250501_20260613_yahoo'],
  ['NFLX', argB || 'hist_NFLX_1d_RTH_20250501_20260613_yahoo'],
];

// ── Exact copies of the production functions from macroRoutes.js ──────────────

function normalizeColumnName(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function findColumnKey(row, candidates) {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.keys(row).map((key) => [key, normalizeColumnName(key)]);
  const normalizedCandidates = candidates.map((key) => normalizeColumnName(key));
  for (const candidate of normalizedCandidates) {
    const found = entries.find(([, normalized]) => normalized === candidate);
    if (found) return found[0];
  }
  return null;
}

function detectDateColumn(candle) {
  return findColumnKey(candle, ['date', 'timestamp', 'datetime', 'time']);
}

function normalizeDateKey(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && Number.isFinite(raw.getTime())) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    if (raw > 1e9) {
      const ms = raw > 1e12 ? raw : raw * 1000;
      const parsed = new Date(ms);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
    }
    return String(raw); // small number — not an epoch
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const datetimePrefix = s.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (datetimePrefix) return datetimePrefix[1];
  const numeric = Number(s);
  if (Number.isFinite(numeric) && numeric > 1e9) {
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = new Date(ms);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

function timeOf(candle) {
  const dateCol = detectDateColumn(candle);
  return normalizeDateKey(dateCol ? candle[dateCol] : null);
}

// ── Inspect one dataset ───────────────────────────────────────────────────────

async function inspect(symbol, datasetId) {
  const sep = '═'.repeat(64);
  console.log(`\n${sep}`);
  console.log(`Dataset: ${datasetId}  (${symbol})`);

  const record = historicalDatasetRegistry.get(datasetId);
  if (!record) {
    console.log('  ❌  Not in registry');
    return null;
  }

  // Which file will be loaded?
  const csvPath  = record.files?.csv  || null;
  const jsonPath = record.files?.json || record.filePath || null;
  const chosenPath = csvPath || jsonPath || null;
  const chosenFormat = chosenPath === csvPath ? 'CSV' : 'JSON';

  console.log(`  filePath   : ${chosenPath}`);
  console.log(`  format     : ${chosenFormat}`);
  console.log(`  fileExists : ${chosenPath ? existsSync(chosenPath) : false}`);

  const result = await readDatasetCandlesAsync(datasetId);
  if (!result.ok) {
    console.log(`  ❌  Load failed: ${result.error}`);
    return null;
  }

  const candles = result.candles;
  console.log(`  candleCount: ${candles.length}`);

  if (candles.length === 0) {
    console.log('  ❌  Empty candle array');
    return null;
  }

  const c0 = candles[0];
  const rawKeys = Object.keys(c0);
  const dateCol  = detectDateColumn(c0);
  const rawDateValue = dateCol ? c0[dateCol] : undefined;

  console.log(`\n  candles[0] raw keys : ${JSON.stringify(rawKeys)}`);
  console.log(`  dateColumn detected : ${JSON.stringify(dateCol)}`);
  console.log(`  raw date value      : ${JSON.stringify(rawDateValue)}  (typeof ${typeof rawDateValue})`);
  console.log(`  raw close value     : ${JSON.stringify(c0.close ?? c0.Close ?? c0.c)}  (typeof ${typeof (c0.close ?? c0.Close ?? c0.c)})`);
  console.log(`  symbol field        : ${JSON.stringify(c0.symbol ?? '(missing)')}`);

  // First 5 timeOf() outputs
  const first5 = candles.slice(0, 5).map((c) => {
    const col = detectDateColumn(c);
    const raw = col ? c[col] : undefined;
    const key = timeOf(c);
    return { rawValue: raw, typeof: typeof raw, timeOfKey: key };
  });
  console.log('\n  First 5 timeOf() outputs:');
  for (const row of first5) {
    const warn = row.timeOfKey == null ? ' ⚠️  NULL KEY' : (String(row.timeOfKey).match(/^\d{10,}$/) ? ' ⚠️  NUMERIC STRING (not a date)' : '');
    console.log(`    raw=${JSON.stringify(row.rawValue)} (${row.typeof}) → "${row.timeOfKey}"${warn}`);
  }

  // Build date key set (for intersection)
  const keys = candles.map((c) => timeOf(c)).filter(Boolean);
  const keySet = new Set(keys);
  const nullCount = candles.length - keys.length;
  const sorted = [...keySet].sort();

  console.log(`\n  valid keys  : ${keys.length} / ${candles.length}  (${nullCount} null)`);
  console.log(`  key type    : ${keys.length > 0 ? (String(keys[0]).match(/^\d{4}-\d{2}-\d{2}$/) ? 'YYYY-MM-DD ✓' : String(keys[0]).match(/^\d{10,}$/) ? 'NUMERIC EPOCH ⚠️' : 'OTHER') : '—'}`);
  console.log(`  firstDate   : ${sorted[0] ?? '—'}`);
  console.log(`  lastDate    : ${sorted[sorted.length - 1] ?? '—'}`);

  return { symbol, datasetId, keySet, keys, sorted };
}

// ── Run ───────────────────────────────────────────────────────────────────────

const results = [];
for (const [symbol, datasetId] of DATASETS) {
  const info = await inspect(symbol, datasetId);
  results.push(info);
}

console.log(`\n${'═'.repeat(64)}`);
console.log('Intersection');

if (results.some((r) => r == null)) {
  console.log('  ❌  Cannot compute — one or both datasets failed to load');
  process.exit(1);
}

const [a, b] = results;
const intersection = [...a.keySet].filter((k) => b.keySet.has(k));
const onlyInA = [...a.keySet].filter((k) => !b.keySet.has(k));
const onlyInB = [...b.keySet].filter((k) => !a.keySet.has(k));

console.log(`  ${a.symbol} keys : ${a.keySet.size}`);
console.log(`  ${b.symbol} keys : ${b.keySet.size}`);
console.log(`  Intersection  : ${intersection.length}`);

if (intersection.length === 0) {
  console.log('\n  ❌  RED — no overlap');
  console.log(`  First 3 ${a.symbol} keys : ${a.sorted.slice(0, 3).join(' | ')}`);
  console.log(`  First 3 ${b.symbol} keys : ${b.sorted.slice(0, 3).join(' | ')}`);
  console.log(`  Only in ${a.symbol} (3)  : ${onlyInA.sort().slice(0, 3).join(' | ')}`);
  console.log(`  Only in ${b.symbol} (3)  : ${onlyInB.sort().slice(0, 3).join(' | ')}`);

  // Root cause diagnosis
  const aIsNumeric = a.keys.length > 0 && String(a.keys[0]).match(/^\d{10,}$/);
  const bIsNumeric = b.keys.length > 0 && String(b.keys[0]).match(/^\d{10,}$/);
  if (aIsNumeric && !bIsNumeric)      console.log(`\n  ROOT CAUSE: ${a.symbol} uses numeric epoch keys, ${b.symbol} uses date strings`);
  else if (!aIsNumeric && bIsNumeric) console.log(`\n  ROOT CAUSE: ${b.symbol} uses numeric epoch keys, ${a.symbol} uses date strings`);
  else if (aIsNumeric && bIsNumeric)  console.log('\n  ROOT CAUSE: both numeric but different values (different intraday UTC offsets?)');
  else                                console.log('\n  ROOT CAUSE: both date strings but different values — check UTC offset or DST');
} else {
  console.log(`\n  ✅  GREEN — ${intersection.length} overlapping date keys`);
  console.log(`  Sample : ${intersection.sort().slice(0, 5).join(' | ')}`);
}
