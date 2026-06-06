export function sanitizeJson(value) {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => {
    const sanitized = sanitizeJson(item);
    return sanitized === undefined ? null : sanitized;
  });
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const sanitized = sanitizeJson(item);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  return null;
}

export function jsonSafe(res, statusCode, payload) {
  return res.status(statusCode).json(sanitizeJson(payload));
}
