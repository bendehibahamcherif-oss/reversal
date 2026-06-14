/**
 * helpers.js — shared utilities for functional tests.
 *
 * Provides:
 *   findFreePort()         → Promise<number>
 *   spawnTestServer(opts)  → Promise<{ port, baseUrl, child, jwtSecret }>
 *   killServer(child)      → Promise<void>
 *   forgeJwt(secret, payload?) → string
 */

import net    from 'node:net';
import cp     from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath }          from 'node:url';
import { createSign }             from 'node:crypto';

// ── HMAC-based JWT forge (no external dependency) ─────────────────────────────
// jsonwebtoken uses HS256 by default. We replicate it here using node:crypto.

import { createHmac } from 'node:crypto';

/**
 * Sign a JWT with HS256 using node:crypto (no external dependency).
 * @param {string} secret
 * @param {object} [extraPayload]
 * @returns {string} signed JWT string
 */
export function forgeJwt(secret, extraPayload = {}) {
  const header  = { alg: 'HS256', typ: 'JWT' };
  const now     = Math.floor(Date.now() / 1000);
  const payload = {
    sub:   'test-uid',
    email: 'test@reversal.test',
    role:  'admin',
    iat:   now,
    exp:   now + 3600,
    ...extraPayload,
  };

  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

  const headerEnc  = b64url(header);
  const payloadEnc = b64url(payload);
  const signing    = `${headerEnc}.${payloadEnc}`;
  const sig        = createHmac('sha256', secret)
    .update(signing)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${signing}.${sig}`;
}

// ── findFreePort ──────────────────────────────────────────────────────────────

/**
 * Bind to port 0 to let the OS pick a free port, then release it.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
    srv.on('error', rej);
  });
}

// ── spawnTestServer ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dir      = dirname(__filename);
// server.js lives at the repo root — three levels up from server/tests/functional/
const REPO_ROOT  = resolve(__dir, '../../../');
const SERVER_JS  = join(REPO_ROOT, 'server.js');

/**
 * Spawn `node server.js` with test environment variables and wait for /health.
 *
 * @param {{ seedDir: string, jwtSecret: string, port?: number }} opts
 * @returns {Promise<{ port: number, baseUrl: string, child: ChildProcess, jwtSecret: string }>}
 */
export async function spawnTestServer({ seedDir, jwtSecret, port: preferredPort, extraEnv } = {}) {
  const port    = preferredPort ?? await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const histDir = seedDir
    ? (seedDir.startsWith('/') ? seedDir : resolve(process.cwd(), seedDir))
    : undefined;

  const env = {
    ...process.env,
    PORT:                 String(port),
    NODE_ENV:             'test',
    JWT_SECRET:           jwtSecret || 'functional-test-secret-change-in-ci',
    // Silence MongoDB connection attempts in test
    MONGO_URI:            '',
    // Relax rate limits so test suites with many requests don't self-429
    RATE_LIMIT_MAX:        String(process.env.RATE_LIMIT_MAX        || '2000'),
    RATE_LIMIT_STRICT_MAX: String(process.env.RATE_LIMIT_STRICT_MAX || '500'),
    // Point the registry at the seed directory
    ...(histDir ? { HISTORICAL_DATA_DIR: histDir } : {}),
    // Caller-supplied overrides (applied last so they win)
    ...(extraEnv || {}),
  };

  const child = cp.spawn(process.execPath, [SERVER_JS], {
    cwd:   REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Pipe stderr/stdout to parent process stderr so failures are visible
  child.stdout.on('data', (d) => process.stderr.write(`[server:stdout] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server:stderr] ${d}`));

  // Wait up to 20 s for /health to return 200
  const TIMEOUT_MS = 20_000;
  const POLL_MS    = 250;
  const deadline   = Date.now() + TIMEOUT_MS;

  await new Promise((res, rej) => {
    // If the child exits early, fail immediately
    child.once('exit', (code) => {
      rej(new Error(`Server process exited early with code ${code}`));
    });

    const poll = async () => {
      if (Date.now() > deadline) {
        child.kill();
        return rej(new Error(`Server did not become healthy within ${TIMEOUT_MS}ms`));
      }
      try {
        const resp = await fetch(`${baseUrl}/health`);
        if (resp.status === 200) {
          // Remove the early-exit listener now that we're up
          child.removeAllListeners('exit');
          return res();
        }
      } catch {
        // Not ready yet — keep polling
      }
      setTimeout(poll, POLL_MS);
    };

    setTimeout(poll, POLL_MS);
  });

  return { port, baseUrl, child, jwtSecret: jwtSecret || 'functional-test-secret-change-in-ci' };
}

// ── killServer ────────────────────────────────────────────────────────────────

/**
 * Gracefully terminate a child process: SIGTERM first, then SIGKILL after 5 s.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
export function killServer(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((res) => {
    const force = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 5_000);

    child.once('exit', () => {
      clearTimeout(force);
      res();
    });

    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  });
}
