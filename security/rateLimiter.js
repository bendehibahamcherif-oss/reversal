// ── Rate Limiter ───────────────────────────────────────────────────────────────
//
// Sliding-window, per-IP rate limiter.
//
// Every response now carries standard rate-limit headers:
//   X-RateLimit-Limit     — configured max requests per window
//   X-RateLimit-Remaining — requests remaining in the current window
//   X-RateLimit-Reset     — Unix timestamp (seconds) when the window resets
//
// Two presets:
//   rateLimiter()       — global limiter (max from RATE_LIMIT_MAX, default 100/min)
//   strictRateLimiter() — mutation endpoints (max from RATE_LIMIT_STRICT_MAX, default 20/min)

// Separate buckets for each named limiter to avoid cross-contamination
const _buckets = new Map();   // limiterKey → Map<ip, timestamp[]>

function _getLimiter(limiterKey, windowMs, max) {
  if (!_buckets.has(limiterKey)) _buckets.set(limiterKey, new Map());
  const store = _buckets.get(limiterKey);

  return (req, res, next) => {
    const ip  = req.ip || 'unknown';
    const now = Date.now();

    if (!store.has(ip)) store.set(ip, []);
    const ts = store.get(ip).filter((t) => now - t < windowMs);
    ts.push(now);
    store.set(ip, ts);

    const remaining = Math.max(0, max - ts.length);
    const resetAt   = Math.ceil((now + windowMs) / 1000);

    res.setHeader('X-RateLimit-Limit',     String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset',     String(resetAt));

    if (ts.length > max) {
      return res.status(429).json({
        error:       'Rate limit exceeded',
        retryAfter:  Math.ceil(windowMs / 1000),
        limit:       max,
        windowMs,
      });
    }

    next();
  };
}

// Global rate limiter — applied to all routes
export function rateLimiter({
  windowMs = 60_000,
  max      = Number(process.env.RATE_LIMIT_MAX) || 100,
} = {}) {
  return _getLimiter('global', windowMs, max);
}

// Strict rate limiter — for sensitive mutation endpoints (execution, OMS cancel, institutional)
export function strictRateLimiter({
  windowMs = 60_000,
  max      = Number(process.env.RATE_LIMIT_STRICT_MAX) || 20,
} = {}) {
  return _getLimiter('strict', windowMs, max);
}
