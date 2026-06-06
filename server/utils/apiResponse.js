/**
 * apiResponse.js — centralized JSON response helpers for all `/api/*` routes.
 *
 * Guarantees that responses are always JSON-safe: NaN/Infinity → null, undefined
 * is dropped, Date → ISO string, Error → safe object, BigInt → string. Use
 * sendOk/sendError so every route shares one structured contract.
 */

/**
 * Recursively coerce a value into something JSON.stringify can serialize without
 * producing NaN, Infinity, or undefined.
 */
export function sanitizeJson(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null;

  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'function' || t === 'symbol') return null;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...(value.code ? { code: value.code } : {}) };
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return null;
    seen.add(value);
    const out = value.map((item) => {
      const s = sanitizeJson(item, seen);
      return s === undefined ? null : s;
    });
    seen.delete(value);
    return out;
  }

  if (t === 'object') {
    if (seen.has(value)) return null;
    // Defer to a custom serializer if present (e.g. toJSON).
    if (typeof value.toJSON === 'function') {
      try { return sanitizeJson(value.toJSON(), seen); } catch { /* fall through */ }
    }
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const s = sanitizeJson(item, seen);
      if (s !== undefined) out[key] = s;
    }
    seen.delete(value);
    return out;
  }

  return null;
}

/** Send a successful JSON response. `data` is merged at the top level. */
export function sendOk(res, data = {}, statusCode = 200) {
  const payload = data && typeof data === 'object' && !Array.isArray(data)
    ? { ok: true, ...data }
    : { ok: true, data };
  return res.status(statusCode).json(sanitizeJson(payload));
}

/** Send a structured JSON error response. */
export function sendError(res, statusCode, status, message, details = {}) {
  return res.status(statusCode).json(sanitizeJson({
    ok: false,
    status,
    message,
    ...(details && Object.keys(details).length ? { details } : {}),
  }));
}
