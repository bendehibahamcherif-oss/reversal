import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Re-import storagePaths with a clean module cache after setting env vars. */
async function importWithEnv(overrides = {}) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Node ESM module cache: use a unique query string to bypass cache
  const { DATA_DIR, ensureDataDir, dataPath } = await import(
    `../utils/storagePaths.js?t=${Date.now()}-${Math.random()}`
  );
  // Restore env
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return { DATA_DIR, ensureDataDir, dataPath };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('storagePaths', () => {
  it('uses DATA_DIR env var when set', async () => {
    const explicit = resolve('/tmp/reversal-explicit-test');
    const { DATA_DIR } = await importWithEnv({ DATA_DIR: explicit, NODE_ENV: undefined, CI: undefined });
    assert.equal(DATA_DIR, explicit);
  });

  it('uses tmp/test-data when NODE_ENV=test and DATA_DIR unset', async () => {
    const { DATA_DIR } = await importWithEnv({ DATA_DIR: undefined, NODE_ENV: 'test', CI: undefined });
    const expected = resolve(process.cwd(), 'tmp', 'test-data');
    assert.equal(DATA_DIR, expected);
  });

  it('uses tmp/test-data when CI=true and DATA_DIR unset', async () => {
    const { DATA_DIR } = await importWithEnv({ DATA_DIR: undefined, NODE_ENV: undefined, CI: 'true' });
    const expected = resolve(process.cwd(), 'tmp', 'test-data');
    assert.equal(DATA_DIR, expected);
  });

  it('never resolves to /var/data when DATA_DIR is not set', async () => {
    const { DATA_DIR } = await importWithEnv({ DATA_DIR: undefined, NODE_ENV: 'test', CI: undefined });
    assert.notEqual(DATA_DIR, '/var/data');
    assert.ok(!DATA_DIR.startsWith('/var/data'), `DATA_DIR must not start with /var/data, got: ${DATA_DIR}`);
  });

  it('ensureDataDir creates the directory', async () => {
    const tmpDir = resolve(process.cwd(), 'tmp', `storage-test-${Date.now()}`);
    const { ensureDataDir } = await importWithEnv({ DATA_DIR: tmpDir, NODE_ENV: undefined, CI: undefined });
    ensureDataDir();
    assert.ok(existsSync(tmpDir), `Expected ${tmpDir} to exist after ensureDataDir()`);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('dataPath resolves a file path under DATA_DIR', async () => {
    const tmpDir = resolve(process.cwd(), 'tmp', `storage-test-${Date.now()}`);
    const { dataPath } = await importWithEnv({ DATA_DIR: tmpDir, NODE_ENV: undefined, CI: undefined });
    const p = dataPath('sub', 'file.json');
    assert.equal(p, join(tmpDir, 'sub', 'file.json'));
    // Parent dir should have been created
    assert.ok(existsSync(join(tmpDir, 'sub')));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
