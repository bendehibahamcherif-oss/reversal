export function clearStaleDependencyError(trainingState, dependencyState) {
  const current = trainingState && typeof trainingState === 'object' ? { ...trainingState } : {};
  if (current.status === 'python_dependency_missing' && dependencyState?.status === 'ready') {
    return { status: 'idle', error: null, lastResponse: null };
  }
  return current;
}

export function beginFreshTrainingRequest(previousState = {}) {
  return {
    ...previousState,
    status: 'training',
    error: null,
    lastResponse: null,
  };
}

export function applyLatestTrainingResponse(_previousState, response) {
  return {
    status: response?.status || (response?.ok ? 'trained' : 'training_failed'),
    error: response?.ok ? null : (response?.message || response?.status || 'Training failed.'),
    lastResponse: response || null,
  };
}
