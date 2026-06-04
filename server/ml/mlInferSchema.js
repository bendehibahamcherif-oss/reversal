// ── ML Inference Schema ────────────────────────────────────────────────────
//
// Lightweight schema validators with no external dependencies.
//
// Input schema  (REST request body):
//   { features: Record<string, number>,  // required, non-empty
//     timeframe?: string,
//     modelId?:  string }
//
// Output schema (Python infer.py stdout):
//   { ok: true, prediction: enum, confidence: [0,1], probabilities: object }

// Phase 9 labels (SHORT/NEUTRAL/LONG) + legacy labels for backward compat
export const VALID_PREDICTIONS = Object.freeze([
  'SHORT', 'NEUTRAL', 'LONG',
  'positive', 'negative', 'neutral',
]);

export class SchemaError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'SchemaError';
    this.errors = errors;
  }
}

// ── Request body validator ─────────────────────────────────────────────────

export function validateRequestBody(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SchemaError('Request body must be a JSON object', ['body must be a JSON object']);
  }

  // features: required, plain object, non-empty, all-numeric values
  if (!body.features || typeof body.features !== 'object' || Array.isArray(body.features)) {
    errors.push('features must be a non-null, non-array object');
  } else {
    const keys = Object.keys(body.features);
    if (keys.length === 0) {
      errors.push('features must have at least one entry');
    } else {
      for (const k of keys) {
        const v = body.features[k];
        if (typeof v !== 'number' || !isFinite(v)) {
          errors.push(`features.${k} must be a finite number, got ${typeof v}`);
        }
      }
    }
  }

  if (body.timeframe !== undefined && typeof body.timeframe !== 'string') {
    errors.push('timeframe must be a string if provided');
  }

  if (body.modelId !== undefined && typeof body.modelId !== 'string') {
    errors.push('modelId must be a string if provided');
  }

  if (errors.length > 0) throw new SchemaError('Invalid request body', errors);
}

// ── Python output validator ────────────────────────────────────────────────

export function validatePythonOutput(result) {
  if (!result || typeof result !== 'object') {
    throw new SchemaError('Python output must be a JSON object', ['not an object']);
  }

  if (result.ok !== true) {
    throw new SchemaError(
      `Python process returned ok:false — ${result.error || 'unknown error'}`,
      [result.error || 'ok:false'],
    );
  }

  const errors = [];

  if (!VALID_PREDICTIONS.includes(result.prediction)) {
    errors.push(
      `prediction must be one of [${VALID_PREDICTIONS.join(', ')}], got: ${result.prediction}`,
    );
  }

  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
    errors.push(`confidence must be a number in [0, 1], got: ${result.confidence}`);
  }

  if (!result.probabilities || typeof result.probabilities !== 'object' || Array.isArray(result.probabilities)) {
    errors.push('probabilities must be a plain object');
  }

  if (errors.length > 0) throw new SchemaError('Python output schema invalid', errors);
}
