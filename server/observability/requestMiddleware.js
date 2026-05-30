// ── Request Middleware ────────────────────────────────────────────────────────
//
// Applied once, early in the middleware stack.  For every request it:
//   1. Generates (or propagates) a trace ID  →  X-Trace-Id response header
//   2. Extracts tenant ID from X-Tenant-Id header (defaults to 'default')
//   3. Runs the remainder of the request inside AsyncLocalStorage so logger.js
//      can pick up traceId / tenantId without explicit propagation
//   4. On response finish: records latency + status to metricsStore and
//      emits a structured JSON access-log line (skippable via REQUEST_LOG=false)

import { randomUUID } from 'node:crypto';
import { requestContext } from './logger.js';
import { metricsStore }   from './metrics.js';

const SERVICE = process.env.SERVICE_NAME || 'reversal-api';

export function requestMiddleware(req, res, next) {
  const traceId  = String(req.headers['x-trace-id'] || `tr_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
  const tenantId = String(req.headers['x-tenant-id'] || 'default');
  const startMs  = Date.now();

  req.traceId  = traceId;
  req.tenantId = tenantId;
  res.setHeader('X-Trace-Id', traceId);

  res.on('finish', () => {
    const durationMs = Date.now() - startMs;
    metricsStore.record(req.method, req.originalUrl || req.url, res.statusCode, durationMs);

    if (process.env.REQUEST_LOG !== 'false') {
      const level = res.statusCode >= 500 ? 'error'
                  : res.statusCode >= 400 ? 'warn'
                  : 'info';
      process.stdout.write(JSON.stringify({
        timestamp:   new Date().toISOString(),
        level,
        service:     SERVICE,
        type:        'access',
        traceId,
        tenantId,
        method:      req.method,
        path:        req.originalUrl || req.url,
        status:      res.statusCode,
        durationMs,
        user:        req.user?.email ?? req.user?.sub ?? null,
      }) + '\n');
    }
  });

  requestContext.run({ traceId, tenantId }, next);
}
