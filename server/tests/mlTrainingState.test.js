import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLatestTrainingResponse,
  beginFreshTrainingRequest,
  clearStaleDependencyError,
} from '../../frontend/mlTrainingState.js';

test('frontend state clears stale python_dependency_missing when dependency endpoint is ready', () => {
  const cleared = clearStaleDependencyError(
    { status: 'python_dependency_missing', error: 'Python ML dependencies are missing.', lastResponse: { status: 'python_dependency_missing' } },
    { status: 'ready', missing: [] },
  );
  assert.deepEqual(cleared, { status: 'idle', error: null, lastResponse: null });
});

test('frontend train flow starts fresh and replaces an old dependency error with latest train response', () => {
  const training = beginFreshTrainingRequest({ status: 'python_dependency_missing', error: 'old error', lastResponse: { status: 'python_dependency_missing' } });
  assert.equal(training.status, 'training');
  assert.equal(training.error, null);
  assert.equal(training.lastResponse, null);

  const latest = applyLatestTrainingResponse(training, { ok: false, status: 'not_enough_data', message: 'Need more rows.' });
  assert.equal(latest.status, 'not_enough_data');
  assert.equal(latest.error, 'Need more rows.');
  assert.equal(latest.lastResponse.status, 'not_enough_data');
});
