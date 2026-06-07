import { sanitizeJson } from '../utils/apiResponse.js';

export function apiNotFoundHandler(req, res) {
  return res.status(404).type('application/json').json(sanitizeJson({
    ok: false,
    status: 'endpoint_not_found',
    message: 'API endpoint not found.',
    endpoint: req.originalUrl || req.path,
    method: req.method,
  }));
}

export function jsonOnlyApiErrors(err, req, res, next) { // eslint-disable-line no-unused-vars
  const isApi = (req.originalUrl || req.path || '').startsWith('/api');
  const statusCode = Number(err?.statusCode || err?.status) || 500;
  const requestId = req.traceId || req.headers?.['x-request-id'] || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  if (res.headersSent) return next(err);
  if (!isApi) {
    return res.status(statusCode).type('application/json').json(sanitizeJson({ ok: false, status: 'internal_error', message: err?.message || 'Internal server error', requestId }));
  }
  const isBodyParseError = err instanceof SyntaxError && Object.hasOwn(err, 'body');
  return res.status(isBodyParseError ? 400 : statusCode).type('application/json').json(sanitizeJson({
    ok: false,
    status: isBodyParseError ? 'invalid_payload' : (err?.code || 'internal_error'),
    message: isBodyParseError ? 'Request body must be a valid JSON object.' : (err?.message || 'Internal server error'),
    endpoint: req.originalUrl || req.path,
    method: req.method,
    requestId,
  }));
}
