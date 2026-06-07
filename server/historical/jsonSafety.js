import { sanitizeJson } from '../utils/apiResponse.js';

export { sanitizeJson };

export function jsonSafe(res, statusCode, payload) {
  return res.status(statusCode).json(sanitizeJson(payload));
}
