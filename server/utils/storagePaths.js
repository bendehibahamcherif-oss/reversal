/**
 * storagePaths.js — central storage path resolver.
 *
 * Priority:
 *   1. DATA_DIR env var (explicit — used in production: DATA_DIR=/var/data)
 *   2. NODE_ENV=test or CI=true → writable repo-local tmp path (./tmp/test-data)
 *   3. Default → ./data (local development)
 *
 * Never hardcode /var/data directly in stores. Always import DATA_DIR from here.
 */

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function resolveDataDir() {
  if (process.env.DATA_DIR) return resolve(process.env.DATA_DIR);
  if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
    return resolve(process.cwd(), 'tmp', 'test-data');
  }
  return resolve(process.cwd(), 'data');
}

export const DATA_DIR = resolveDataDir();

/** Resolve a path under DATA_DIR and ensure all parent dirs exist. */
export function dataPath(...parts) {
  const p = join(DATA_DIR, ...parts);
  mkdirSync(join(DATA_DIR, ...parts.slice(0, -1 || undefined)), { recursive: true });
  return p;
}

/** Ensure DATA_DIR itself exists and return it. */
export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}
