// ── Structured JSON Logger ────────────────────────────────────────────────────
//
// Outputs newline-delimited JSON to stdout (errors to stderr).
// Uses AsyncLocalStorage so traceId / tenantId thread automatically through
// the request lifecycle without being passed as explicit arguments.
//
// Usage:
//   import { logger } from './logger.js';
//   logger.info('order placed', { orderId, symbol });
//   logger.child({ component: 'omsEngine' }).warn('transition blocked', { from, to });
//
// Correlation IDs are injected by requestMiddleware.js via requestContext.run().

import { AsyncLocalStorage } from 'node:async_hooks';

export const requestContext = new AsyncLocalStorage();

const SERVICE = process.env.SERVICE_NAME || 'reversal-api';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function _write(level, msg, ctx = {}) {
  if ((LEVELS[level] ?? 0) < MIN_LEVEL) return;
  const store  = requestContext.getStore() || {};
  const entry  = {
    timestamp: new Date().toISOString(),
    level,
    service:   SERVICE,
    traceId:   store.traceId   ?? null,
    tenantId:  store.tenantId  ?? 'default',
    msg,
    ...ctx,
  };
  const line = JSON.stringify(entry) + '\n';
  if (level === 'error') process.stderr.write(line);
  else                   process.stdout.write(line);
}

function makeLogger(defaults = {}) {
  return {
    debug: (msg, ctx) => _write('debug', msg, { ...defaults, ...ctx }),
    info:  (msg, ctx) => _write('info',  msg, { ...defaults, ...ctx }),
    warn:  (msg, ctx) => _write('warn',  msg, { ...defaults, ...ctx }),
    error: (msg, ctx) => _write('error', msg, { ...defaults, ...ctx }),
    child: (extra)    => makeLogger({ ...defaults, ...extra }),
  };
}

export const logger = makeLogger();
