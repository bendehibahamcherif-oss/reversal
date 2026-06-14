/**
 * serve-test.js — Start the real server with seeded test data for manual exploration.
 *
 * Usage:
 *   HISTORICAL_DATA_DIR=./test-seed node server/tests/functional/serve-test.js
 *
 * If SEED_MANIFEST.json doesn't exist, runs the seed script first.
 * Stays running until killed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cp from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dir      = dirname(__filename);
const REPO_ROOT  = resolve(__dir, '../../../');

// ── Resolve seed directory ────────────────────────────────────────────────────

const rawSeedDir = process.env.SEED_DIR || process.env.HISTORICAL_DATA_DIR || './test-seed';
const SEED_DIR   = isAbsolute(rawSeedDir) ? rawSeedDir : resolve(process.cwd(), rawSeedDir);
const MANIFEST_PATH = join(SEED_DIR, 'SEED_MANIFEST.json');

// ── Seed if needed ────────────────────────────────────────────────────────────

async function ensureSeeded() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log('[serve-test] SEED_MANIFEST.json not found — running seed script…');
    await new Promise((res, rej) => {
      const seedScript = join(REPO_ROOT, 'scripts', 'seed-test-data.js');
      const child = cp.spawn(process.execPath, [seedScript], {
        cwd: REPO_ROOT,
        env: { ...process.env, HISTORICAL_DATA_DIR: SEED_DIR },
        stdio: 'inherit',
      });
      child.once('exit', (code) => {
        if (code === 0) res();
        else rej(new Error(`Seed script exited with code ${code}`));
      });
      child.once('error', rej);
    });
  }
}

// ── Start server ──────────────────────────────────────────────────────────────

async function main() {
  await ensureSeeded();

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch (err) {
    console.error('[serve-test] Failed to read SEED_MANIFEST.json:', err.message);
    process.exit(1);
  }

  const port      = Number(process.env.TEST_PORT) || manifest.testPort || 9999;
  const jwtSecret = manifest.jwtSecret || 'functional-test-secret-change-in-ci';
  const serverJs  = join(REPO_ROOT, 'server.js');

  const env = {
    ...process.env,
    PORT:                 String(port),
    NODE_ENV:             'test',
    JWT_SECRET:           jwtSecret,
    MONGO_URI:            '',
    HISTORICAL_DATA_DIR:  SEED_DIR,
  };

  console.log('');
  console.log('=======================================================');
  console.log(' Reversal API — Test Server');
  console.log(`  Port:       ${port}`);
  console.log(`  Base URL:   http://localhost:${port}`);
  console.log(`  Seed dir:   ${SEED_DIR}`);
  console.log(`  JWT secret: ${jwtSecret}`);
  console.log('');
  console.log('  Seeded datasets:');
  for (const [sym, info] of Object.entries(manifest.datasets || {})) {
    console.log(`    ${sym}: ${info.datasetId} (${info.candleCount} candles)`);
  }
  console.log('=======================================================');
  console.log('');

  const child = cp.spawn(process.execPath, [serverJs], {
    cwd:   REPO_ROOT,
    env,
    stdio: 'inherit',
  });

  child.once('exit', (code) => {
    console.log(`[serve-test] Server exited with code ${code}`);
    process.exit(code ?? 0);
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`\n[serve-test] Received ${sig} — shutting down server…`);
      try { child.kill(sig); } catch { /* already gone */ }
    });
  }
}

main().catch((err) => {
  console.error('[serve-test] Fatal:', err.message);
  process.exit(1);
});
