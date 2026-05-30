// ── In-Process Metrics Store ───────────────────────────────────────────────────
//
// Tracks per-route latency and error counts in a bounded ring buffer.
// No external dependency — designed to be scraped by the /api/observability/metrics
// endpoint or forwarded to an external TSDB on export.
//
// Ring buffer keeps the last SAMPLE_WINDOW samples per route so percentile
// computations remain stable without unbounded memory growth.
//
// Route normalisation collapses dynamic path segments:
//   /api/oms/orders/oms_172_abc  →  /api/oms/orders/:id
//   /api/execution/orders/exec_1  →  /api/execution/orders/:id

const SAMPLE_WINDOW = 1000;

// ── Percentile helper ─────────────────────────────────────────────────────────

function _pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

// ── Path normalisation ────────────────────────────────────────────────────────

const _ID_RE = /\/[a-zA-Z0-9_\-]{8,}(?=\/|$)/g;

function normalisePath(raw) {
  return raw
    .replace(/\?.*$/, '')              // strip query string
    .replace(_ID_RE, '/:id');          // collapse IDs
}

// ── Metrics store ─────────────────────────────────────────────────────────────

class MetricsStore {
  constructor() {
    this._routes    = new Map();  // key → { count, errors, latencies[] }
    this._startedAt = Date.now();
    this._totalReqs = 0;
    this._totalErrs = 0;
  }

  record(method, rawPath, statusCode, durationMs) {
    const route = `${method} ${normalisePath(rawPath)}`;
    if (!this._routes.has(route)) {
      this._routes.set(route, { count: 0, errors: 0, latencies: [] });
    }
    const entry = this._routes.get(route);
    entry.count++;
    if (statusCode >= 500) { entry.errors++; this._totalErrs++; }
    entry.latencies.push(durationMs);
    if (entry.latencies.length > SAMPLE_WINDOW) entry.latencies.shift();
    this._totalReqs++;
  }

  getSummary() {
    const routes = [];
    for (const [route, d] of this._routes) {
      const sorted = [...d.latencies].sort((a, b) => a - b);
      routes.push({
        route,
        count:     d.count,
        errors:    d.errors,
        errorRate: d.count > 0 ? Number((d.errors / d.count * 100).toFixed(2)) : 0,
        p50:       _pct(sorted, 0.50),
        p95:       _pct(sorted, 0.95),
        p99:       _pct(sorted, 0.99),
        maxMs:     sorted.length ? sorted[sorted.length - 1] : null,
        minMs:     sorted.length ? sorted[0] : null,
      });
    }
    routes.sort((a, b) => b.count - a.count);

    const uptimeSecs   = Math.floor((Date.now() - this._startedAt) / 1000);
    const globalErrPct = this._totalReqs > 0
      ? Number((this._totalErrs / this._totalReqs * 100).toFixed(2))
      : 0;

    return {
      uptimeSecs,
      startedAt:     new Date(this._startedAt).toISOString(),
      totalRequests: this._totalReqs,
      totalErrors:   this._totalErrs,
      globalErrorPct: globalErrPct,
      routeCount:    routes.length,
      routes,
    };
  }

  reset() {
    this._routes.clear();
    this._totalReqs = 0;
    this._totalErrs = 0;
    this._startedAt = Date.now();
  }
}

export const metricsStore = new MetricsStore();
