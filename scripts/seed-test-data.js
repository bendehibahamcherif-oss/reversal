/**
 * seed-test-data.js
 *
 * Downloads stable historical candles for SPY, NFLX, QQQ, AAPL via Yahoo Finance
 * and writes a SEED_MANIFEST.json so the functional test suite can reference
 * the seeded dataset IDs.
 *
 * Usage:
 *   HISTORICAL_DATA_DIR=./test-seed node scripts/seed-test-data.js [--force]
 *
 * Exit codes:
 *   0  — success (or skipped because manifest already valid)
 *   1  — failure
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── Resolve seed directory ────────────────────────────────────────────────────

const envDir = process.env.HISTORICAL_DATA_DIR;
if (!envDir) {
  console.error('[seed] HISTORICAL_DATA_DIR is not set. Example: HISTORICAL_DATA_DIR=./test-seed node scripts/seed-test-data.js');
  process.exit(1);
}

const SEED_DIR = envDir.startsWith('/') ? envDir : resolve(process.cwd(), envDir);
const MANIFEST_PATH = join(SEED_DIR, 'SEED_MANIFEST.json');
const FORCE = process.argv.includes('--force');

// ── Symbols and date range ────────────────────────────────────────────────────

const SEED_SYMBOLS = ['SPY', 'NFLX', 'QQQ', 'AAPL'];
const JWT_SECRET   = 'functional-test-secret-change-in-ci';
const TEST_PORT    = 9999;

// startDate = 180 days ago, endDate = 30 days ago → stable window regardless of run date
const now       = Date.now();
const startDate = new Date(now - 180 * 86_400_000).toISOString().slice(0, 10);
const endDate   = new Date(now -  30 * 86_400_000).toISOString().slice(0, 10);

// ── Check existing manifest ───────────────────────────────────────────────────

function isManifestValid(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  if (!manifest.datasets || typeof manifest.datasets !== 'object') return false;
  const keys = Object.keys(manifest.datasets);
  if (!SEED_SYMBOLS.every((s) => keys.includes(s))) return false;
  for (const sym of SEED_SYMBOLS) {
    const entry = manifest.datasets[sym];
    if (!entry || !entry.datasetId || !entry.candleCount || entry.candleCount < 1) return false;
  }
  return true;
}

if (!FORCE && existsSync(MANIFEST_PATH)) {
  try {
    const existing = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    if (isManifestValid(existing)) {
      console.log('[seed] SEED_MANIFEST.json already valid — skipping download. Use --force to re-download.');
      process.exit(0);
    }
    console.log('[seed] Existing manifest is incomplete — re-seeding.');
  } catch {
    console.log('[seed] Could not parse existing manifest — re-seeding.');
  }
}

// ── Ensure seed directory and set HISTORICAL_DATA_DIR for the registry ────────

mkdirSync(SEED_DIR, { recursive: true });

// The registry reads HISTORICAL_DATA_DIR at module load time, so it must be set
// before we import the service. We set it here; the env var is already in the
// environment since this process was launched with it.

// ── Import download service ───────────────────────────────────────────────────

const { downloadHistoricalDataset } = await import('../server/historical/historicalDataService.js');

// ── Download each symbol ──────────────────────────────────────────────────────

console.log(`[seed] Seeding ${SEED_SYMBOLS.join(', ')} from ${startDate} to ${endDate} ...`);
console.log(`[seed] Seed directory: ${SEED_DIR}`);

const datasets = {};
let allOk = true;

for (const symbol of SEED_SYMBOLS) {
  process.stdout.write(`[seed]   Downloading ${symbol} ...`);
  try {
    const result = await downloadHistoricalDataset({
      symbol,
      timeframe: '1d',
      provider:  'yahoo',
      startDate,
      endDate,
      purpose:   'correlation',
      session:   'RTH',
    });

    if (!result.ok) {
      console.error(` FAILED: ${result.error} — ${result.detail ?? ''}`);
      allOk = false;
      continue;
    }

    const { dataset, candleCount } = result;
    datasets[symbol] = {
      datasetId:  dataset.datasetId,
      candleCount: candleCount ?? dataset.rowCount ?? dataset.candleCount ?? 0,
      startDate:  dataset.startDate,
      endDate:    dataset.endDate,
    };
    console.log(` OK (${datasets[symbol].candleCount} candles, id=${dataset.datasetId})`);
  } catch (err) {
    console.error(` ERROR: ${err?.message ?? err}`);
    allOk = false;
  }
}

if (!allOk) {
  console.error('[seed] One or more symbols failed to download. Aborting.');
  process.exit(1);
}

// ── Write SEED_MANIFEST.json ──────────────────────────────────────────────────

const manifest = {
  generatedAt: new Date().toISOString(),
  seedDir:     SEED_DIR,
  jwtSecret:   JWT_SECRET,
  testPort:    TEST_PORT,
  datasets,
};

writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log(`[seed] SEED_MANIFEST.json written to ${MANIFEST_PATH}`);
console.log(`[seed] Done. Seeded ${Object.keys(datasets).length} datasets.`);
process.exit(0);
